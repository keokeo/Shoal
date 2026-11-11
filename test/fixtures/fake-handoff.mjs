// Fake headless generator for e2e tests (agent `fake`): reads the prompt from stdin.
// Handoff prompts get a deterministic card: HANDOFF_FAIL in the prompt -> exit 1; HANDOFF_SLOW -> answers after 3 s.
// Title prompts (they start with TITLE_PROMPT_HEAD from server/titles.ts) get a title plus an explanation line:
// TITLE_FAIL in the prompt -> exit 1; TITLE_SLOW -> answers after 3 s.
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => (input += d));
process.stdin.on('end', async () => {
  if (input.startsWith('给下面这个编程任务起一个标题。')) {
    if (input.includes('TITLE_FAIL')) process.exit(1);
    if (input.includes('TITLE_SLOW')) await new Promise(r => setTimeout(r, 3000));
    const req = input.split('任务需求：\n').slice(1).join('任务需求：\n');
    const first = req.split(/\r?\n/).find(l => l.trim()) ?? '';
    console.log(`「AI：${[...first.trim()].slice(0, 10).join('')}」\n\n（这是解释，不该进标题）`);
    return;
  }
  if (input.includes('HANDOFF_FAIL')) process.exit(1);
  if (input.includes('HANDOFF_SLOW')) await new Promise(r => setTimeout(r, 3000));
  const last = input.split('\n').filter(l => l.startsWith('【用户】')).at(-1);
  console.log(['## 目标', 'FAKE-HANDOFF', '## 下一步', last ? last.slice(0, 200) : '（记录里没有）', `prompt-chars: ${input.length}`].join('\n'));
});
