// Laadt de browserscripts (geen modules) in een eigen vm-context, zoals index.html ze laadt.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');

/**
 * @param {string[]} files  scripts in de volgorde van index.html
 * @param {object} [globals] extra browserglobals (nep-fetch, nep-document, sessionStorage ...)
 */
function loadScripts(files, globals = {}) {
  const context = vm.createContext({ console, ...globals });
  context.window = context; // zoals in de browser: window is het globale object
  for (const file of files) {
    const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
    // Een file://-URL als naam, zodat `node --experimental-test-coverage` deze scripts meetelt.
    vm.runInContext(code, context, { filename: pathToFileURL(path.join(ROOT, file)).href });
  }
  // `const` en `function` op topniveau zitten in de globale scope van de context.
  const get = (name) => vm.runInContext(name, context);
  get.context = context;
  return get;
}

module.exports = { loadScripts };
