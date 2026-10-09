const fs = require('fs');
const path = '../sidecar/test_streaming.py';
let code = fs.readFileSync(path, 'utf8');

code = code.replace(
  `first = self.transcript.update(result(["Moving"], 0.0), self.snapshot)
        second = self.transcript.update(result(["Moving"], 0.7), self.snapshot)
        self.assertEqual(first["words"][0]["wordId"], second["words"][0]["wordId"])
        self.assertTrue(second["words"][0]["provisional"])
        self.assertAlmostEqual(second["words"][0]["videoStart"], 10.7)`,
  `first = self.transcript.update(result(["Moving"], 0.0), self.snapshot)
        second = self.transcript.update(result(["Moving"], 1.1), self.snapshot)
        self.assertEqual(first["words"][0]["wordId"], second["words"][0]["wordId"])
        self.assertTrue(second["words"][0]["provisional"])
        self.assertAlmostEqual(second["words"][0]["videoStart"], 11.1)`
);

fs.writeFileSync(path, code);
