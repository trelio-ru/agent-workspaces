#!/usr/bin/env python3
"""Stable entrypoint for the Vkus-private complete HR read-only surface."""

from trelio_one_c_vkus_kadry_runtime import HR_SKILL_ID, main


if __name__ == "__main__":
    raise SystemExit(main(expected_skill_id=HR_SKILL_ID))
