/*!
 * tests/run.js —— 一次跑完全部测试
 * 运行：node tests/run.js   （或 npm test）
 */
'use strict';

require('./core.test.js');
require('./ui-smoke.test.js');
require('./pwa.test.js');

process.on('exit', function (code) {
  console.log('\n全部测试结束。');
  if (code === 0) console.log('\u2705 所有用例通过');
  else console.log('\u274c 存在失败用例');
});