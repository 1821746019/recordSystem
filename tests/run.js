/*!
 * tests/run.js —— 一次跑完全部测试
 * 运行：node tests/run.js   （或 npm test）
 */
'use strict';

require('./core.test.js');
require('./ui-smoke.test.js');
require('./pwa.test.js');

// sw.test.js 是异步的（要等 promise 落地），用子进程同步跑，
// 这样输出顺序和退出码都能并入这一次汇总。
try {
  require('child_process').execFileSync(
    process.execPath,
    [require('path').join(__dirname, 'sw.test.js')],
    { stdio: 'inherit' }
  );
} catch (e) {
  process.exitCode = 1;
}

process.on('exit', function (code) {
  console.log('\n全部测试结束。');
  if (code === 0) console.log('\u2705 所有用例通过');
  else console.log('\u274c 存在失败用例');
});