// Laadt de browserscripts (geen modules) in een eigen vm-context, zoals index.html ze laadt.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function loadScripts(files) {
  const context = vm.createContext({ console });
  context.window = context; // zoals in de browser: window is het globale object
  for (const file of files) {
    const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
    vm.runInContext(code, context, { filename: file });
  }
  // `const` en `function` op topniveau zitten in de globale scope van de context.
  return (name) => vm.runInContext(name, context);
}

module.exports = { loadScripts };
