const Ferris = require('./index');
const Readline = require('readline');

// Load skills
var skills = Ferris.loadSkills('skills');

Ferris.listen(skills, () => { rl.close(); });

// Provide a keyboard prompt
var rl = Readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.on('line', command => {
  rl.pause();

  Ferris.parseCommand(skills, command, () => { rl.close(); });
  Ferris.restartSTT(skills, true);

  // Unpause and refresh the prompt
  rl.prompt();
}).on('close', () => {
  // Clean-up
  Ferris.quiet();
  if (Ferris.activeSkill) {
    Ferris.endSession(Ferris.activeSkill);
  }

  process.exit(0);
});

rl.prompt();

