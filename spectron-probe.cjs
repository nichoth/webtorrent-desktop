const Application = require('spectron').Application
const path = require('path')
const app = new Application({
  path: path.join(__dirname, 'node_modules', '.bin', 'electron'),
  args: [path.join(__dirname)],
  env: { NODE_ENV: 'test' },
  waitTimeout: 10e3
})
app.start().then(() => {
  console.log('STARTED ok')
  return app.stop()
}).catch(e => {
  console.log('START FAILED:', e && e.message)
  console.log(((e && e.stack) || '').split('\n').slice(0, 12).join('\n'))
})
