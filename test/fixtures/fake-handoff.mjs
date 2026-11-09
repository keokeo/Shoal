// Fake handoff generator for e2e tests: reads the prompt from stdin and prints a deterministic card.
// HANDOFF_FAIL in the prompt -> exit 1; HANDOFF_SLOW -> answers after 3 s.
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => (input += d));
process.stdin.on('end', async () => {
  if (input.includes('HANDOFF_FAIL')) process.exit(1);
  if (input.includes('HANDOFF_SLOW')) await new Promise(r => setTimeout(r, 3000));
  const last = input.split('\n').filter(l => l.startsWith('【用户】')).at(-1);
  console.log(['## 目标', 'FAKE-HANDOFF', '## 下一步', last ? last.slice(0, 200) : '（记录里没有）', `prompt-chars: ${input.length}`].join('\n'));
});
