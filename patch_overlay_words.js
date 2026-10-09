const fs = require('fs');
const path = 'extension/src/content/overlay.ts';
let code = fs.readFileSync(path, 'utf8');

const setWordsRe = /setWords\(words: CaptionWord\[\]\): void \{\s*\/\/ legacy replay passes the entire history; don't concat it endlessly\s*this\.words = words\.slice\(\);\s*this\.words\.sort\(\(a, b\) => a\.videoStart - b\.videoStart\);/;
code = code.replace(setWordsRe, `setWords(words: CaptionWord[]): void {
    // Append new legacy words (for incremental updates)
    this.words = this.words.concat(words);
    this.words.sort((a, b) => a.videoStart - b.videoStart);`);

const mergeReplayRe = /mergeReplay\(words: CaptionWord\[\]\): void \{\n    const streaming = words\.filter\(word => Boolean\(word\.wordId\)\);\n    this\.transcript\.mergeFinalized\(streaming\);\n    if \(streaming\.length\) \{\n      this\.words = this\.transcript\.values\(\);\n      this\.groupsDirty = true;\n      this\.reconcileLines\(\);\n    \}\n    const legacy = words\.filter\(word => !word\.wordId\);\n    if \(legacy\.length\) this\.setWords\(legacy\);\n  \}/;
code = code.replace(mergeReplayRe, `mergeReplay(words: CaptionWord[]): void {
    const streaming = words.filter(word => Boolean(word.wordId));
    this.transcript.mergeFinalized(streaming);
    
    const legacy = words.filter(word => !word.wordId);
    
    // Replay Replaces all legacy words instead of appending them
    this.words = this.transcript.values().concat(legacy);
    this.words.sort((a, b) => a.videoStart - b.videoStart);
    this.groupsDirty = true;
    this.reconcileLines();
  }`);

fs.writeFileSync(path, code);
