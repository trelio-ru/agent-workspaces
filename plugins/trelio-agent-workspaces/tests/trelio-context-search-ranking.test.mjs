import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CONTEXT_SEARCH_RANKING_POLICY_VERSION,
  buildContextSearchRank,
  compareContextSearchCandidates,
} from "../scripts/trelio-context-search-ranking.mjs";

const fixturePath = fileURLToPath(new URL(
  "./fixtures/context-search-ranking-v1.json",
  import.meta.url,
));
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

test("local context ranking follows the cross-provider v1 golden vectors", async (context) => {
  assert.equal(fixture.policyVersion, CONTEXT_SEARCH_RANKING_POLICY_VERSION);

  for (const fixtureCase of fixture.cases) {
    await context.test(fixtureCase.name, () => {
      const actualOrder = [...fixtureCase.candidates]
        .sort(compareContextSearchCandidates)
        .map((candidate) => candidate.id);

      assert.deepEqual(actualOrder, fixtureCase.expectedOrder);
    });
  }
});

test("one formulation found in several fields is counted once at its strongest field", () => {
  const duplicateFieldCandidate = {
    type: "task",
    title: "Atlas",
    stableKey: "acme/mobile/1/task",
    matches: [
      { query: "Atlas", source: "task-comment", previewText: "Atlas" },
      { query: "atlas", source: "task-title", previewText: "Atlas" },
    ],
  };
  const twoQueryCandidate = {
    type: "contact",
    title: "Atlas vendor",
    stableKey: "acme/2/contact",
    matches: [
      { query: "Atlas", source: "contact-name", previewText: "Atlas vendor" },
      { query: "vendor", source: "contact-name", previewText: "Atlas vendor" },
    ],
  };

  assert.equal(compareContextSearchCandidates(twoQueryCandidate, duplicateFieldCandidate) < 0, true);
});

test("an exact contact channel survives a duplicate title hit for the same formulation", () => {
  const rank = buildContextSearchRank({
    type: "contact",
    title: "alice@example.test",
    stableKey: "acme/contact-1/contact",
    matches: [
      { query: "alice@example.test", source: "contact-name", previewText: "alice@example.test" },
      {
        query: "alice@example.test",
        source: "contact-channel",
        previewText: "Email · alice@example.test",
      },
    ],
  });

  assert.equal(rank.exactReferenceMatches, 1);
  assert.equal(rank.matchedQueryCount, 1);
});
