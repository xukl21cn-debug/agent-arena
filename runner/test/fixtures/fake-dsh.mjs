let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const mode = process.env.FAKE_DSH_MODE ?? 'ok';
  const sessionId = 'session-fake';
  console.log(JSON.stringify({ type: 'session', sessionId, cwd: process.cwd() }));

  if (mode === 'spawn-fail') {
    console.error('fake dsh failed');
    process.exit(1);
  }
  if (mode === 'error-event') {
    console.log(JSON.stringify({ type: 'error', message: 'fake startup failure' }));
    process.exit(1);
  }
  if (mode === 'hang') {
    setTimeout(() => {}, 60_000);
    return;
  }

  // Report how the CLI was started, so a test can see that a session was resumed.
  const resumeArg = process.argv.indexOf('--session-id');
  const resumed = resumeArg === -1 ? 'new session' : `resumed ${process.argv[resumeArg + 1]}`;
  const result = {
    summary: `fake dsh read ${input.length} bytes, ${resumed}`,
    files: ['smoke.txt'],
    commits: ['abcdef0'],
    tests: [{ command: 'fake test', outcome: 'passed' }],
    docs: [],
  };
  const text = mode === 'malformed'
    ? 'done without a result block'
    : `done\n\`\`\`arena-result\n${JSON.stringify(result)}\n\`\`\``;
  console.log(JSON.stringify({ type: 'text', text }));
  if (mode === 'empty-final') {
    console.log(JSON.stringify({ type: 'final', sessionId, reason: { kind: 'completed' }, text: '' }));
    return;
  }
  if (mode !== 'no-final') {
    console.log(JSON.stringify({ type: 'final', sessionId, reason: { kind: 'completed' }, text }));
  }
});
