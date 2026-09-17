import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const MINIMUM_GIT_VERSION = Object.freeze({
  major: 2,
  minor: 28,
  patch: 0,
});

const MINIMUM_GIT_VERSION_TEXT = [
  MINIMUM_GIT_VERSION.major,
  MINIMUM_GIT_VERSION.minor,
  MINIMUM_GIT_VERSION.patch,
].join(".");

const toGitCompatiblePath = (filePath) => (
  process.platform === "win32" ? filePath.replaceAll("\\", "/") : filePath
);

// Git for Windows does not consistently interpret Node's `os.devNull`
// (`\\.\nul`) as a configuration file or hooks directory. Unique absolute
// paths that intentionally do not exist isolate ambient config and hooks on
// every platform without creating persistent files or relying on shell path
// translation.
const gitIsolationRoot = toGitCompatiblePath(
  path.join(
    os.tmpdir(),
    `trelio-git-isolation-${process.pid}-${randomUUID()}`,
  ),
);

export const GIT_DISABLED_GLOBAL_CONFIG_PATH = `${gitIsolationRoot}/global-config`;
export const GIT_DISABLED_HOOKS_PATH = `${gitIsolationRoot}/hooks`;

const normalizeComparablePath = (filePath, platform) => (
  platform === "win32" ? filePath.toLowerCase() : filePath
);

const getEnvironmentValue = (environment, name, platform) => {
  if (platform !== "win32") {
    return environment[name];
  }

  const matchingKey = Object.keys(environment).find(
    (key) => key.toLowerCase() === name.toLowerCase(),
  );
  return matchingKey ? environment[matchingKey] : undefined;
};

const expandWindowsEnvironmentVariables = (value, environment) => (
  String(value || "").replace(/%([^%]+)%/gu, (match, variableName) => (
    getEnvironmentValue(environment, variableName, "win32") || match
  ))
);

const splitAbsolutePathEntries = (value, { platform, environment }) => {
  const pathImplementation = platform === "win32" ? path.win32 : path.posix;
  const delimiter = platform === "win32" ? path.win32.delimiter : path.posix.delimiter;

  return String(value || "")
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/gu, ""))
    .map((entry) => (
      platform === "win32"
        ? expandWindowsEnvironmentVariables(entry, environment)
        : entry
    ))
    // Пустой элемент PATH означает cwd. Локальный repository не является
    // доверенным источником системного executable, поэтому такой элемент и
    // любые другие относительные пути намеренно игнорируются.
    .filter((entry) => entry && pathImplementation.isAbsolute(entry));
};

const addCandidate = (candidates, seen, candidatePath, source, platform) => {
  if (!candidatePath) {
    return;
  }

  const pathImplementation = platform === "win32" ? path.win32 : path.posix;
  if (!pathImplementation.isAbsolute(candidatePath)) {
    return;
  }

  const normalized = normalizeComparablePath(
    pathImplementation.normalize(candidatePath),
    platform,
  );
  if (seen.has(normalized)) {
    return;
  }

  seen.add(normalized);
  candidates.push({ path: candidatePath, source });
};

const addPathCandidates = (
  candidates,
  seen,
  pathValue,
  source,
  { platform, environment, executableName },
) => {
  const pathImplementation = platform === "win32" ? path.win32 : path.posix;
  for (const directory of splitAbsolutePathEntries(pathValue, { platform, environment })) {
    addCandidate(
      candidates,
      seen,
      pathImplementation.join(directory, executableName),
      source,
      platform,
    );
  }
};

/**
 * Build deterministic Git candidates without invoking `where`, `which`, a
 * shell, or Codex's private plugin-manager runtime. Ambient process PATH is
 * deliberately not a source: it is checked later only to report whether an
 * allowlisted standalone candidate is already visible to the current process.
 * The function is exported so Windows/macOS path behavior can be tested on
 * every CI host.
 */
export const collectGitCandidates = ({
  platform = process.platform,
  environment = process.env,
  machinePath = "",
  userPath = "",
} = {}) => {
  const candidates = [];
  const seen = new Set();
  const executableName = platform === "win32" ? "git.exe" : "git";
  const pathImplementation = platform === "win32" ? path.win32 : path.posix;
  const candidateOptions = { platform, environment, executableName };

  if (platform === "win32") {
    const programFilesRoots = [
      getEnvironmentValue(environment, "ProgramW6432", platform),
      getEnvironmentValue(environment, "ProgramFiles", platform),
      getEnvironmentValue(environment, "ProgramFiles(x86)", platform),
    ];
    for (const root of programFilesRoots) {
      if (!root || !pathImplementation.isAbsolute(root)) {
        continue;
      }
      addCandidate(
        candidates,
        seen,
        pathImplementation.join(root, "Git", "cmd", executableName),
        "program-files",
        platform,
      );
      addCandidate(
        candidates,
        seen,
        pathImplementation.join(root, "Git", "bin", executableName),
        "program-files",
        platform,
      );
    }

    const localAppData = getEnvironmentValue(environment, "LOCALAPPDATA", platform);
    if (localAppData && pathImplementation.isAbsolute(localAppData)) {
      addCandidate(
        candidates,
        seen,
        pathImplementation.join(localAppData, "Programs", "Git", "cmd", executableName),
        "local-app-data",
        platform,
      );
      addCandidate(
        candidates,
        seen,
        pathImplementation.join(localAppData, "Programs", "Git", "bin", executableName),
        "local-app-data",
        platform,
      );
    }

    // Codex Desktop can keep a stale process PATH after an installer has
    // already updated durable Windows environment values. Check both scopes
    // explicitly so the freshly installed Git is usable without app restart.
    addPathCandidates(
      candidates,
      seen,
      machinePath,
      "machine-path",
      candidateOptions,
    );
    addPathCandidates(
      candidates,
      seen,
      userPath,
      "user-path",
      candidateOptions,
    );
  } else if (platform === "darwin") {
    addCandidate(candidates, seen, "/opt/homebrew/bin/git", "homebrew", platform);
    addCandidate(candidates, seen, "/usr/local/bin/git", "local", platform);
    addCandidate(candidates, seen, "/opt/local/bin/git", "macports", platform);
    addCandidate(candidates, seen, "/opt/pkg/bin/git", "pkgsrc", platform);
    addCandidate(candidates, seen, "/usr/bin/git", "system", platform);
  } else {
    addCandidate(candidates, seen, "/usr/local/bin/git", "local", platform);
    addCandidate(candidates, seen, "/usr/bin/git", "system", platform);
    addCandidate(candidates, seen, "/bin/git", "system", platform);
    addCandidate(candidates, seen, "/snap/bin/git", "snap", platform);
    addCandidate(
      candidates,
      seen,
      "/home/linuxbrew/.linuxbrew/bin/git",
      "homebrew",
      platform,
    );
    addCandidate(
      candidates,
      seen,
      "/run/current-system/sw/bin/git",
      "nix-system",
      platform,
    );
  }

  return candidates;
};

const isExecutableOnProcessPath = (
  candidatePath,
  { platform, environment, processPath, executableName },
) => {
  const pathImplementation = platform === "win32" ? path.win32 : path.posix;
  const comparableCandidate = normalizeComparablePath(
    pathImplementation.normalize(candidatePath),
    platform,
  );

  return splitAbsolutePathEntries(processPath, { platform, environment })
    .some((directory) => (
      normalizeComparablePath(
        pathImplementation.normalize(
          pathImplementation.join(directory, executableName),
        ),
        platform,
      ) === comparableCandidate
    ));
};

export const parseGitVersion = (value) => {
  const match = String(value || "").match(
    /git version\s+(?<major>[0-9]+)\.(?<minor>[0-9]+)(?:\.(?<patch>[0-9]+))?/iu,
  );
  if (!match?.groups) {
    return null;
  }

  const version = {
    major: Number(match.groups.major),
    minor: Number(match.groups.minor),
    patch: Number(match.groups.patch || 0),
  };
  return {
    ...version,
    text: `${version.major}.${version.minor}.${version.patch}`,
  };
};

export const isSupportedGitVersion = (version) => {
  if (!version) {
    return false;
  }

  for (const key of ["major", "minor", "patch"]) {
    if (version[key] > MINIMUM_GIT_VERSION[key]) {
      return true;
    }
    if (version[key] < MINIMUM_GIT_VERSION[key]) {
      return false;
    }
  }
  return true;
};

const canonicalizeExecutable = async (candidatePath, filesystem) => {
  try {
    const candidateStat = await filesystem.stat(candidatePath);
    if (!candidateStat.isFile()) {
      return null;
    }
    return await filesystem.realpath(candidatePath);
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error?.code)) {
      return null;
    }
    throw error;
  }
};

const inspectGitExecutable = async (gitPath, execFileCommand) => {
  try {
    const result = await execFileCommand(gitPath, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      shell: false,
      windowsHide: true,
    });
    const version = parseGitVersion(result.stdout || result.stderr);
    return version ? { status: "ok", version } : { status: "invalid" };
  } catch {
    // `/usr/bin/git` on a clean macOS installation can be only an xcrun stub
    // whose `--version` fails until Command Line Tools are installed. Treat it
    // as unavailable instead of accepting the path by existence alone.
    return { status: "invalid" };
  }
};

const readDurableWindowsPaths = async ({ environment, execFileCommand }) => {
  const systemRoot = getEnvironmentValue(environment, "SystemRoot", "win32")
    || getEnvironmentValue(environment, "WINDIR", "win32")
    || "C:\\Windows";
  const powershellPath = path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const script = [
    "$ErrorActionPreference='Stop'",
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
    "$result=[pscustomobject]@{machinePath=[Environment]::GetEnvironmentVariable('Path','Machine');userPath=[Environment]::GetEnvironmentVariable('Path','User')}",
    "[Console]::Out.Write(($result | ConvertTo-Json -Compress))",
  ].join("; ");

  try {
    const { stdout } = await execFileCommand(
      powershellPath,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
        shell: false,
        windowsHide: true,
      },
    );
    const parsed = JSON.parse(
      String(stdout || "{}").trim().replace(/^\uFEFF/u, ""),
    );
    return {
      machinePath: typeof parsed.machinePath === "string" ? parsed.machinePath : "",
      userPath: typeof parsed.userPath === "string" ? parsed.userPath : "",
    };
  } catch {
    // Standard Program Files roots are still checked below. A damaged or
    // policy-disabled PowerShell must not turn an otherwise valid Git into an
    // authentication or workspace error.
    return { machinePath: "", userPath: "" };
  }
};

const resolveExistingExecutable = async (
  candidates,
  { filesystem, platform },
) => {
  const seenCanonicalPaths = new Set();

  for (const candidate of candidates) {
    const executablePath = await canonicalizeExecutable(candidate.path, filesystem);
    if (!executablePath) {
      continue;
    }
    const comparablePath = normalizeComparablePath(executablePath, platform);
    if (seenCanonicalPaths.has(comparablePath)) {
      continue;
    }
    seenCanonicalPaths.add(comparablePath);
    return { ...candidate, path: executablePath };
  }

  return null;
};

export const resolveGitInstallPlan = async ({
  platform = process.platform,
  environment = process.env,
  filesystem = fs,
} = {}) => {
  if (platform === "darwin") {
    const brewCandidates = [];
    const seen = new Set();
    addCandidate(brewCandidates, seen, "/opt/homebrew/bin/brew", "homebrew", platform);
    addCandidate(brewCandidates, seen, "/usr/local/bin/brew", "homebrew", platform);
    const brew = await resolveExistingExecutable(brewCandidates, { filesystem, platform });

    if (brew) {
      return {
        strategy: "homebrew",
        executable: brew.path,
        args: ["install", "git"],
        displayCommand: "brew install git",
        requiresNativeApproval: true,
        waitsForCompletion: true,
      };
    }

    return {
      strategy: "xcode-command-line-tools",
      executable: "/usr/bin/xcode-select",
      args: ["--install"],
      displayCommand: "xcode-select --install",
      requiresNativeApproval: true,
      waitsForCompletion: false,
      nativeWindowExpected: true,
    };
  }

  if (platform === "win32") {
    const windowsPath = path.win32;
    const wingetCandidates = [];
    const seen = new Set();
    const localAppData = getEnvironmentValue(environment, "LOCALAPPDATA", platform);
    if (localAppData && windowsPath.isAbsolute(localAppData)) {
      addCandidate(
        wingetCandidates,
        seen,
        windowsPath.join(localAppData, "Microsoft", "WindowsApps", "winget.exe"),
        "windows-app-installer",
        platform,
      );
    }
    const winget = await resolveExistingExecutable(
      wingetCandidates,
      { filesystem, platform },
    );

    if (winget) {
      return {
        strategy: "winget",
        executable: winget.path,
        args: [
          "install",
          "--id",
          "Git.Git",
          "-e",
          "--source",
          "winget",
          "--accept-source-agreements",
          "--accept-package-agreements",
        ],
        displayCommand: "winget install --id Git.Git -e --source winget --accept-source-agreements --accept-package-agreements",
        requiresNativeApproval: true,
        waitsForCompletion: true,
      };
    }

    return {
      strategy: "official-installer",
      executable: null,
      args: [],
      displayCommand: null,
      url: "https://git-scm.com/download/win",
      requiresNativeApproval: true,
      waitsForCompletion: false,
      nativeWindowExpected: true,
    };
  }

  return null;
};

/**
 * Resolve and verify a real standalone Git executable. A path returned by this
 * function is absolute, exists as a regular file and has successfully answered
 * `git --version`; the private Git used by a host's plugin manager is never a
 * candidate.
 */
export const resolveGitExecutable = async ({
  platform = process.platform,
  environment = process.env,
  processPath = getEnvironmentValue(environment, "PATH", platform),
  machinePath,
  userPath,
  filesystem = fs,
  execFileCommand = execFileAsync,
  loadDurableWindowsPaths = readDurableWindowsPaths,
} = {}) => {
  let durablePaths = {
    machinePath: machinePath || "",
    userPath: userPath || "",
  };
  if (
    platform === "win32"
    && machinePath === undefined
    && userPath === undefined
  ) {
    durablePaths = await loadDurableWindowsPaths({ environment, execFileCommand });
  }

  const candidates = collectGitCandidates({
    platform,
    environment,
    machinePath: durablePaths.machinePath,
    userPath: durablePaths.userPath,
  });
  const executableName = platform === "win32" ? "git.exe" : "git";
  const seenCanonicalPaths = new Set();
  let firstIncompatible = null;

  for (const candidate of candidates) {
    const gitPath = await canonicalizeExecutable(candidate.path, filesystem);
    if (!gitPath) {
      continue;
    }

    const comparablePath = normalizeComparablePath(gitPath, platform);
    if (seenCanonicalPaths.has(comparablePath)) {
      continue;
    }
    seenCanonicalPaths.add(comparablePath);

    const inspection = await inspectGitExecutable(gitPath, execFileCommand);
    if (inspection.status !== "ok") {
      continue;
    }

    const resolved = {
      status: isSupportedGitVersion(inspection.version) ? "ready" : "upgrade_required",
      code: isSupportedGitVersion(inspection.version) ? null : "TRELIO_GIT_REQUIRED",
      gitPath,
      version: inspection.version.text,
      minimumVersion: MINIMUM_GIT_VERSION_TEXT,
      source: candidate.source,
      processPathReady: isExecutableOnProcessPath(candidate.path, {
        platform,
        environment,
        processPath,
        executableName,
      }),
    };
    if (resolved.status === "ready") {
      return resolved;
    }
    firstIncompatible ||= resolved;
  }

  const install = await resolveGitInstallPlan({
    platform,
    environment,
    filesystem,
  });
  if (firstIncompatible) {
    return { ...firstIncompatible, install };
  }

  return {
    status: "not_found",
    code: "TRELIO_GIT_REQUIRED",
    gitPath: null,
    version: null,
    minimumVersion: MINIMUM_GIT_VERSION_TEXT,
    source: null,
    processPathReady: false,
    install,
  };
};

const executeGit = async (gitPath, args, options, execFileCommand) => (
  execFileCommand(
    gitPath,
    [
      "-c",
      `core.hooksPath=${GIT_DISABLED_HOOKS_PATH}`,
      "-c",
      "init.templateDir=",
      "-c",
      "core.longpaths=true",
      ...args,
    ],
    {
      ...options,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: GIT_DISABLED_GLOBAL_CONFIG_PATH,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_PAGER: "cat",
        GIT_TERMINAL_PROMPT: "0",
        ...options.env,
      },
    },
  )
);

/**
 * Prove that the executable supports the exact local operations required by
 * Agent Workspaces. Version output alone is insufficient on an xcrun stub or a
 * policy-blocked Windows executable, so doctor creates and commits one tiny
 * temporary repository and removes it in `finally`.
 */
export const verifyGitRuntime = async ({
  filesystem = fs,
  execFileCommand = execFileAsync,
  temporaryRoot = os.tmpdir(),
  ...resolverOptions
} = {}) => {
  const resolved = await resolveGitExecutable({
    filesystem,
    execFileCommand,
    ...resolverOptions,
  });
  if (resolved.status !== "ready") {
    return resolved;
  }

  const temporaryDirectory = await filesystem.mkdtemp(
    path.join(temporaryRoot, "trelio-git-doctor-"),
  );
  let phase = "init";

  try {
    await executeGit(
      resolved.gitPath,
      ["init", "--initial-branch=main"],
      { cwd: temporaryDirectory },
      execFileCommand,
    );
    phase = "config";
    await executeGit(
      resolved.gitPath,
      ["config", "user.name", "Trelio Git Doctor"],
      { cwd: temporaryDirectory },
      execFileCommand,
    );
    await executeGit(
      resolved.gitPath,
      ["config", "user.email", "git-doctor@trelio.local"],
      { cwd: temporaryDirectory },
      execFileCommand,
    );
    phase = "write";
    await filesystem.writeFile(
      path.join(temporaryDirectory, "README.md"),
      "Trelio Git doctor\n",
      "utf8",
    );
    phase = "add";
    await executeGit(
      resolved.gitPath,
      ["add", "README.md"],
      { cwd: temporaryDirectory },
      execFileCommand,
    );
    phase = "commit";
    await executeGit(
      resolved.gitPath,
      ["commit", "-m", "Trelio Git doctor"],
      { cwd: temporaryDirectory },
      execFileCommand,
    );
    phase = "verify";
    await executeGit(
      resolved.gitPath,
      ["rev-parse", "--verify", "HEAD"],
      { cwd: temporaryDirectory },
      execFileCommand,
    );
    return { ...resolved, smokeTest: "ready" };
  } catch {
    return {
      ...resolved,
      status: "unusable",
      code: "TRELIO_GIT_REQUIRED",
      smokeTest: "failed",
      failedPhase: phase,
      install: await resolveGitInstallPlan({
        platform: resolverOptions.platform,
        environment: resolverOptions.environment,
        filesystem,
      }),
    };
  } finally {
    await filesystem.rm(temporaryDirectory, { recursive: true, force: true });
  }
};

export class GitPrerequisiteError extends Error {
  constructor(diagnostic) {
    const state = diagnostic?.status === "upgrade_required"
      ? `установленная версия ${diagnostic.version} ниже минимальной`
      : diagnostic?.status === "unusable"
        ? "найденный Git не прошёл локальную проверку"
        : "Git не найден";
    const installHint = diagnostic?.install?.displayCommand
      ? ` Запустите \`${diagnostic.install.displayCommand}\` и повторите команду.`
      : diagnostic?.install?.url
        ? ` Установите Git с ${diagnostic.install.url} и повторите команду.`
        : " Установите Git штатным способом для этой системы и повторите команду.";
    super(
      `TRELIO_GIT_REQUIRED: ${state}; требуется Git ${diagnostic?.minimumVersion || MINIMUM_GIT_VERSION_TEXT}+.${installHint}`,
    );
    this.name = "GitPrerequisiteError";
    this.code = "TRELIO_GIT_REQUIRED";
    this.diagnostic = diagnostic;
  }
}
