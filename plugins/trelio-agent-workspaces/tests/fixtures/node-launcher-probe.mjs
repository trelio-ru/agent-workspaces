// This tiny fixture keeps the Windows launcher smoke test on the same
// repository-relative entrypoint contract as the real MCP manifest.
process.stdout.write(JSON.stringify(process.argv.slice(2)));
