const Ferris = require('./index');
const Readline = require('readline');

// Load skills
Ferris.loadSkills('skills');

// Start listening to voice
Ferris.listen(() => { Ferris.say('yes?'); }, () => { rl.close(); });

// Provide a keyboard prompt
var rl = Readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.on('line', command => {
  rl.pause();

  var command;
  if (!(command = Ferris.parseCommand(command, () => { rl.close(); }))) {
    console.log('Command unrecognised');
  } else {
    command();
    Ferris.restartSTT(true);
  }

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

