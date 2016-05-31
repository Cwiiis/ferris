const Concat = require('concat-stream');
const ChildProcess = require('child_process');
const Fs = require('fs');
const Mic = require('mic');
const Nlp = require('nlp_compromise');
const Path = require('path');
const PocketSphinx = require('pocketsphinx').ps;
const Readline = require('readline');

// Load kills
function loadSkills() {
  var skillsPath = Path.join(__dirname, 'skills');
  var skills = [];
  Fs.readdirSync(skillsPath).forEach(path => {
    // Check that this is a directory and not a file
    var skillDir = Path.join(skillsPath, path);
    if (!Fs.statSync(skillDir).isDirectory()) {
      return;
    }

    // Check that the src and speechAssets directories exist
    var srcDir = Path.join(skillDir, 'src');
    var intentsDir = Path.join(skillDir, 'speechAssets');
    if (!Fs.statSync(srcDir).isDirectory() ||
        !Fs.statSync(intentsDir).isDirectory()) {
      return;
    }

    // Check the intent and utterances files exist
    var intentSchemaFile = Path.join(intentsDir, 'IntentSchema.json');
    var utterancesFile = Path.join(intentsDir, 'SampleUtterances.txt');
    if (!Fs.statSync(intentSchemaFile).isFile() ||
        !Fs.statSync(utterancesFile).isFile()) {
      return;
    }

    // Load the skill
    console.log('Loading skill: ' + path);
    var srcPath = Path.join(srcDir, 'index.js');
    try {
      var skill = {};
      skill.name = path;
      skill.module = require(srcPath);
      skill.intents = {};
      skill.customSlots = {};

      // Read intents and slots
      var data = Fs.readFileSync(intentSchemaFile, 'utf-8');
      var intentSchema = JSON.parse(data);
      for (var intent of intentSchema.intents) {
        var localIntent = skill.intents[intent.intent] = {};
        if (intent.slots) {
          localIntent.slots = {};
          for (var slot of intent.slots) {
            localIntent.slots[slot.name] = slot.type;
          }
        }
      }

      // Check for custom slots
      try {
        var slotsDir = Path.join(intentsDir, 'customSlotTypes');
        if (Fs.statSync(slotsDir).isDirectory()) {
          Fs.readdirSync(slotsDir).forEach(slotName => {
            // Ignore hidden files
            if (slotName.startsWith('.')) {
              return;
            }

            var slotFile = Path.join(slotsDir, slotName);

            // Make sure it's a file
            if (!Fs.statSync(slotFile).isFile()) {
              return;
            }

            skill.customSlots[slotName] = [];
            data = Fs.readFileSync(slotFile, 'utf-8');
            var slotValues = data.split('\n');
            for (var slotValue of slotValues) {
              if (slotValue.length) {
                skill.customSlots[slotName].push(slotValue);
              }
            }
          });
        }
      } catch(e) {}

      // Read utterances
      data = Fs.readFileSync(utterancesFile, 'utf-8');
      var utterances = data.split('\n');
      for (var utterance of utterances) {
        for (var intent in skill.intents) {
          if (utterance.startsWith(intent)) {
            if (!skill.intents[intent].utterances) {
              skill.intents[intent].utterances = [];
            }
            skill.intents[intent].utterances.push(
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
var sessionAttributes = {};
function createEvent(type, attributes) {
  return {
    version: '1.0',
    session: {
      sessionId: sessionId,
      application: {
      },
      attributes: sessionAttributes
    },
    request: {
      requestId: requestId++,
      type: type,
      timestamp: Date.now()
    }
  };
}

var speechProcess = null;
function quiet() {
  if (speechProcess) {
    speechProcess.kill('SIGINT');
  }
}

function say(text) {
  quiet();
  speechProcess = ChildProcess.execFile('espeak', ['-m', text]);

  speechProcess.on('exit', () => {
    speechProcess = null;
  });
}

function createContext(skill) {
  return {
    fail: e => {
      console.error('Event failed', e);
    },
    succeed: o => {
      console.log('Event succeeded');
      if (!o) {
        return;
      }

      console.log('Output:', o);

      var speech = o.response.outputSpeech;
      if (speech) {
        switch (speech.type) {
          case 'SSML':
            say(speech.ssml);
            break;

          case 'PlainText':
            say(speech.text);
            break;

          default:
            console.warn('Unrecognised speech type: ' + speech.type);
        }
      }

      if (o.response.shouldEndSession) {
        endSession(skill);
      }
    }
  };
}

function startSession(skill, id) {
  if (id) {
    sessionId = id;
  }
  sessionAttributes = {};

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

function launch(skill, intent, slots) {
  var event = createEvent('IntentRequest');
  event.request.intent = { name: intent, slots: slots ? slots : {} };
  skill.module.handler(event, skill.context);
}

function listSkills(skills) {
  for (var skill of skills) {
    console.log('Skill \'' + skill.name + '\'');
    for (var intent in skill.intents) {
      console.log('\tIntent \'' + intent + '\'');
      intent = skill.intents[intent];
      if (intent.utterances) {
        for (var utterance of intent.utterances) {
          console.log('\t\tUtterance \'' + utterance + '\'');
        }
      }
      if (intent.slots) {
        for (var slot in intent.slots) {
          console.log('\t\tSlot \'' + slot + '\': ' + intent.slots[slot]);
        }
      }
    }
    for (var customSlot in skill.customSlots) {
      console.log('\tCustom slot \'' + customSlot + '\'');
      for (var slotValue of skill.customSlots[customSlot]) {
        console.log('\t\tSlot value \'' + slotValue + '\'');
      }
    }
  }
}

function normaliseString(string) {
  return string.replace(/ +/, ' ').toLocaleLowerCase().trim();
}

function normaliseCamelCase(string) {
  return normaliseString(string.replace(/([A-Z])/, ' $1'));
}

// Translate input text with a particular matched skill/intent with slot output
function matchSlot(skill, intent, slotName, text) {
  if (!intent.slots) {
    return null;
  }

  if (intent.slots[slotName]) {
    var slotType = intent.slots[slotName];

    // Check custom slots
    if (skill.customSlots[slotType]) {
      for (var utterance of skill.customSlots[slotType]) {
        if (utterance.localeCompare(text) === 0) {
          return utterance;
        }
      }
    }

    // Check built-in slots
    if (slotType.startsWith('AMAZON.')) {
      switch(slotType) {
        case 'AMAZON.DATE':
          var date = Nlp.date(text);
          console.log(date);

          // TODO: Surprising nlp doesn't support this, see about adding it.
          //       It also doesn't seem to support durations, or have a concept
          //       about week-ends.
          if (date.normal === 'today' ||
              date.normal === 'now') {
            return new Date().toDateString();
          }

          // Don't return a partial date if we have no information at all
          if (date.data.year === null &&
              date.data.month === null &&
              date.data.day === null) {
            break;
          }

          // Assume this year if none specified
          var dateString = '' + (date.data.year ? date.data.year :
            new Date().getFullYear());

          if (date.data.month) {
            dateString += '-' + (date.data.month + 1);

            if (date.data.day) {
              dateString += '-' + date.data.day;
            }
          }

          return dateString;

        case 'AMAZON.DURATION':
          // TODO: nlp doesn't have a 'duration' concept, see about adding it.
          break;

        case 'AMAZON.FOUR_DIGIT_NUMBER':
          break;

        case 'AMAZON.NUMBER':
          var value = Nlp.value(text);
          if (Number.isFinite(value.number)) {
            return value.number;
          }
          break;

        case 'AMAZON.TIME':
          var date = Nlp.date(text);

          // TODO: Surprising nlp doesn't support this, see about adding it.
          //       It also doesn't seem to support durations, or have a concept
          //       about week-ends.
          if (date.normal === 'today' ||
              date.normal === 'now') {
            return new Date().toTimeString().slice(0, 5);
          }

          // TODO: nlp doesn't seem to have any concept of time either?

          break;

        // TODO: nlp has very few cities and no states
        case 'AMAZON.US_CITY':
          return Nlp.place(text).city;

        case 'AMAZON.US_FIRST_NAME':
          return Nlp.person(text).firstName;

        case 'AMAZON.US_STATE':
          return Nlp.place(text).region;

        case 'AMAZON.LITERAL':
          return text;
      }
    }
  }

  return null;
}

function matchIntent(skill, intent, input) {
  if (!intent.utterances) {
    return null;
  }

  // TODO: Investigate using nlp for fuzzy matching of utterances?

  for (var utterance of intent.utterances) {
    var split = utterance.split(/({[^}]*})/);
    // Fast-path
    if (!intent.slots || split.length <= 1) {
      if (utterance.localeCompare(input) == 0) {
        return {};
      }
      continue;
    }

    // Match the non-slot parts of the utterance to extract the parts that
    // should apply to slots.
    var index = 0;
    var slots = [];
    var lastMatch = null;
    var badMatch = false;
    for (var substring of split) {
      if (substring === '') {
        continue;
      }
      if (substring.startsWith('{') && substring.endsWith('}')) {
        lastMatch = { name: substring.slice(1, -1),
                      text: '' };
        slots.push(lastMatch);
        continue;
      }

      var substringIndex = input.indexOf(substring, index);
      if (substringIndex !== -1) {
        if (lastMatch) {
          lastMatch.text = input.slice(index, substringIndex);
        }
        index = substringIndex + substring.length;
        lastMatch = null;
      } else {
        // A part of the utterance didn't match
        badMatch = true;
        break;
      }
    }

    if (badMatch) {
      continue;
    }

    if (lastMatch) {
      lastMatch.text = input.slice(index);
    }

    // Now try to match slots with the rest of the string
    var result = {};
    for (var slotMatch of slots) {
      // Greedily match the string
      var words = slotMatch.text.split(' ');
      for (var i = words.length; i > 0; i--) {
        var matchString = words[0];
        for (var j = 1; j < i; j++) {
          matchString += ' ' + words[j];
        }
        var value = matchSlot(skill, intent, slotMatch.name,
                              normaliseString(matchString));
        if (value !== null) {
          result[slotMatch.name] = { value: value };
          break;
        }
      }
      if (!result[slotMatch.name]) {
        badMatch = true;
        break;
      }
    }

    if (badMatch) {
      continue;
    }

    return result;
  }

  return null;
}

function buildGrammar(skills, activeSkills) {
  var grammar = '#JSGF V1.0;\ngrammar ferris;\n\n';

  // Add grammar for built-in slots

  // Add grammar for built-in commands
  grammar +=
    '<ferris.command> = exit | quit | help | list | grammar | stop ;\n';

  // Add grammar for launching skills
  if (skills.length > 0 ) {
    grammar += '<ferris.launcher> = ';
    for (var skill of skills) {
      grammar += `launch ${normaliseCamelCase(skill.name)} | `;
    }
    grammar = grammar.slice(0, -2) + ';\n';
  }

  // Add grammar for given array of skills
  for (var skill of activeSkills) {
    if (!skill) {
      continue;
    }

    grammar += '\n';

    // Add grammar for custom slots
    if (skill.customSlots) {
      for (var slotName in skill.customSlots) {
        if (skill.customSlots[slotName].length <= 0) {
          continue;
        }

        var slotGrammar = `<${skill.name}.${slotName}> = `;
        for (var slotText of skill.customSlots[slotName]) {
          slotGrammar += `${normaliseString(slotText)} | `;
        }
        grammar += slotGrammar.slice(0, -2) + ';\n';
      }
    }

    // Add grammar for intents
    for (var intentName in skill.intents) {
      var intent = skill.intents[intentName];
      if (!intent.utterances || intent.utterances.length <= 0) {
        continue;
      }

      var intentGrammars = `<${skill.name}.${intentName}> = `;
      for (var utterance of intent.utterances) {
        intentGrammar = utterance;

        for (var slotName in intent.slots) {
          intentGrammar = intentGrammar.replace(new RegExp(`{${slotName}}`),
            `<${skill.name}.${intent.slots[slotName]}>`);
        }

        if (!intent.slots) {
          intentGrammar = normaliseString(utterance);
        } else {
          // Normalise the parts of the string between slots
          var split = intentGrammar.split(/ *<[^>]*> */);
          var slots = intentGrammar.match(/<[^>]*>/g);
          var normalised = '';
          for (var word of split) {
            normalised += `${normaliseString(word)} `;
            var slot = slots.shift();
            if (slot) {
              normalised += `${slot} `;
            }
          }
          intentGrammar = normalised.slice(0, -1);
        }

        intentGrammars += `${intentGrammar} | `;
      }
      grammar += intentGrammars.slice(0, -2) + ';\n';
    }
  }

  // Build the public rule
  grammar += '\npublic <ferris.input> = <ferris.command> | <ferris.launcher>';
  for (var skill of activeSkills) {
    if (!skill) {
      continue;
    }

    for (var intentName in skill.intents) {
      var intent = skill.intents[intentName];
      if (!intent.utterances || intent.utterances.length <= 0) {
        continue;
      }

      grammar += ` | <${skill.name}.${intentName}>`;
    }
  }
  grammar += ' ;\n';

  return grammar;
}

function parseCommand(command, onexit) {
  command = normaliseString(command);

  switch (command.replace(/ .*$/, '')) {
    case 'exit':
    case 'quit':
      if (onexit) {
        onexit();
      }
      break;

    case 'help':
    case 'list':
      listSkills(skills);
      break;

    case 'launch':
      var matched = false;
      for (var skill of skills) {
        var skillName = command.replace(/launch /, '');
        if (skillName === normaliseString(skill.name) ||
            skillName === normaliseCamelCase(skill.name)) {
          if (activeSkill !== skill) {
            if (activeSkill) {
              endSession(activeSkill);
              activeSkill = null;
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

    case 'grammar':
      console.log(buildGrammar(skills, [activeSkill]));
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
          var result = matchIntent(activeSkill, activeSkill.intents[intent],
                                   command);
          if (result) {
            launch(activeSkill, intent, result);
            if (!activeSkill.context) {
              activeSkill = null;
            }
            return;
          }
        }
      }
      console.log('Command unrecognised');
      break;
  }
}

// Load skills
var skills = loadSkills();

// Provide a user prompt
var activeSkill = null;
var quit = false;

var rl = Readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.on('line', command => {
  rl.pause();

  parseCommand(command, () => { rl.close(); });

  // Unpause and refresh the prompt
  rl.prompt();
}).on('close', () => {
  // Clean-up
  quiet();
  if (activeSkill) {
    endSession(activeSkill);
    activeSkill = null;
  }

  process.exit(0);
});

rl.prompt();

