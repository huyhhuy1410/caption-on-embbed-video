const fs = require('fs');
const path = 'extension/src/content/fullscreen.ts';
let code = fs.readFileSync(path, 'utf8');

// Fix button styling so SVG isn't overflowing or text isn't weird
const mountButtonRe = /button\.className = "cc-fullscreen-btn";/;
code = code.replace(mountButtonRe, `button.className = "cc-fullscreen-btn";
    // Inline style ensures the icon displays properly if the page overrides button styles
    button.style.cssText = "display: flex; align-items: center; justify-content: center; font-size: 16px; width: 24px; height: 24px; line-height: 1; padding: 0; background: rgba(0, 0, 0, 0.5); color: white; border: 1px solid rgba(255, 255, 255, 0.3); border-radius: 4px; cursor: pointer; backdrop-filter: blur(4px); box-sizing: border-box;";`);

fs.writeFileSync(path, code);
