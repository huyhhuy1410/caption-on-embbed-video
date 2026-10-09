const fs = require('fs');
const path = '../backend/src/audio/audio.gateway.ts';
let code = fs.readFileSync(path, 'utf8');

code = code.replace(
  `    if (
      old &&
      (scope.sessionId !== old.sessionId ||
        scope.generation < old.generation ||
        (scope.generation === old.generation &&
          scope.sourceId !== old.sourceId))
    )
      return false;`,
  `    if (
      old &&
      scope.sessionId === old.sessionId &&
      (scope.generation < old.generation ||
        (scope.generation === old.generation &&
          scope.sourceId !== old.sourceId))
    )
      return false;`
);

fs.writeFileSync(path, code);
