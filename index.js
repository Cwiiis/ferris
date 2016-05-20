var concat = require('concat-stream');
var Fs = require('fs');
var Mic = require('mic');
var Path = require('path');
var Prompt = require('prompt-sync')();

var skillsPath = Path.join(__dirname, 'skills');

function loadSkills() {
  var skills = [];
  Fs.readdirSync(skillsPath).forEach(path => {
    var skillDir = Path.join(skillsPath, path);
    if (!Fs.statSync(skillDir).isDirectory()) {
      return;
    }

    var srcDir = Path.join(skillDir, 'src');
    var intentsDir = Path.join(skillDir, 'speechAssets');
    if (!Fs.statSync(srcDir).isDirectory() ||
        !Fs.statSync(intentsDir).isDirectory()) {
      return;
    }

    var intentSchemaFile = Path.join(intentsDir, 'IntentSchema.json');
    var utterancesFile = Path.join(intentsDir, 'SampleUtterances.txt');
    if (!Fs.statSync(intentSchemaFile).isFile() ||
        !Fs.statSync(utterancesFile).isFile()) {
      return;
    }

    console.log('Loading skill: ' + path);
    var srcPath = Path.join(srcDir, 'index.js');
    try {
      var skill = {};
      skill.name = path;
      skill.module = require(srcPath);
      skill.intents = {};

      var data = Fs.readFileSync(intentSchemaFile, 'utf-8');
      var intentSchema = JSON.parse(data);
      for (var intent of intentSchema.intents) {
        skill.intents[intent.intent] = [];
      }

      data = Fs.readFileSync(utterancesFile, 'utf-8');
      var utterances = data.split('\n');
      for (var utterance of utterances) {
        for (var intent in skill.intents) {
          if (utterance.startsWith(intent)) {
            skill.intents[intent].push(
              utterance.substr(intent.length + 1));
            break;
          }
        }
      }

      skills.push(skill);
      console.log('Successfully loaded skill: ' + path);
    } catch(e) {
      console.error('Failed to load skill: ' + path, e);
    }
  });
  return skills;
}

var requestId = 0;
var sessionId = 'DefaultSession';

function createEvent(type) {
  return {
    session: {
      sessionId: sessionId,
      application: {
      },
      new: true
    },
    request: {
      requestId: requestId++,
      type: type
    }
  };
}

function createContext(skill) {
  return {
    fail: e => {
      console.error('Event failed', e);
    },
    succeed: o => {
      console.log('Event succeeded', o);
      if (o && o.response.outputSpeech.shouldEndSession) {
        endSession(skill);
      }
    }
  };
}

function startSession(skill, id) {
  if (id) {
    sessionId = id;
  }

  skill.context = createContext(skill);
  var event = createEvent('LaunchRequest');
  event.session.new = true;

  skill.module.handler(event, skill.context);
}

function endSession(skill) {
  var event = createEvent('SessionEndedRequest');
  skill.module.handler(event, skill.context);
  delete skill.context;
}

function launch(skill, intent) {
  var event = createEvent('IntentRequest');
  event.request.intent = { name: intent, slots: {} };
  skill.module.handler(event, skill.context);
}

function listSkills() {
  for (var skill of skills) {
    console.log('Skill \'' + skill.name + '\'');
    for (var intent in skill.intents) {
      console.log('\tIntent \'' + intent + '\'');
      for (var utterance of skill.intents[intent]) {
        console.log('\t\tUtterance \'' + utterance + '\'');
      }
    }
  }
}

function normaliseString(string) {
  return string.replace(/ +/, ' ').toLocaleLowerCase().trim();
}

// Load skills
var skills = loadSkills();

// Provide a user prompt
var activeSkill = null;
var quit = false;
while (true) {
  var string = Prompt('> ');
  if (!string) {
    break;
  }

  var matched = false;
  var command = normaliseString(string);
  switch (command.replace(/ .*$/, '')) {
    case 'exit':
    case 'quit':
      quit = true;
      break;

    case 'help':
    case 'list':
      listSkills();
      break;

    case 'launch':
      for (var skill of skills) {
        if (command.replace(/launch /, '') === normaliseString(skill.name)) {
          if (activeSkill !== skill) {
            if (activeSkill) {
              endSession(activeSkill);
            }
            startSession(skill);
            if (skill.context) {
              activeSkill = skill;
            }
            matched = true;
            break;
          }
        }
      }
      if (!matched) {
        console.log('Skill not found');
      }
      break;

    case 'stop':
      if (activeSkill) {
        endSession(activeSkill);
        activeSkill = null;
      } else {
        console.log('No active skill');
      }
      break;

    default:
      if (activeSkill) {
        for (var intent in activeSkill.intents) {
          for (var utterance of activeSkill.intents[intent]) {
            // TODO: Investigate using nlp for fuzzy matching?
            if (utterance.localeCompare(command) == 0) {
              launch(activeSkill, intent);
              if (!activeSkill.context) {
                activeSkill = null;
              }
              matched = true;
              break;
            }
          }
          if (matched) {
            break;
          }
        }
      }
      if (!matched) {
        console.log('Command unrecognised');
      }
      break;
  }

  if (quit) {
    break;
  }
}

// Clean-up
if (activeSkill) {
  endSession(activeSkill);
  activeSkill = null;
}
