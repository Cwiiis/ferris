const ChildProcess = require('child_process');
const Fs = require('fs');
const Nlp = require('nlp_compromise');
const Path = require('path');
const Wakeword = require('wakeword');

Wakeword.logFile = '/dev/null';

module.exports = {

// Skill properties
skills: [],
activeSkill: null,

// Alexa event properties
requestId: 0,
sessionId: 'DefaultSession',
sessionAttributes: {},

// Speech synthesis properties
speechCommand: { name: 'espeak', args: ['-m'] },
speechProcess: null,
listenWhileSpeaking: false,

// Words not in the pocketsphinx dictionary that we've warned on the console
warnWords: {},

// Wake-word variables
wakeWord: 'ferris',
wakeTime: 10000,
wakeTimeout: null,
awake: false,

// Enable/disable built-in commands via speech
enableBuiltins: true,

// Speech input properties
decoder: null,
speechMatch: null,
speechMatchTime: 0,
speechSampleTime: 0,
noiseLevel: { average: 0, samples: 0 },
noiseThreshold: 100,
matchThreshold: 8000,

// Load skills
loadSkills: function(skillsPath) {
  var skills = [];
  skillsPath = Path.resolve(skillsPath);
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
        localIntent.persist = intent.persist;
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
  this.skills = skills;
},

createEvent: function (type, attributes) {
  return {
    version: '1.0',
    session: {
      sessionId: this.sessionId,
      application: {
      },
      attributes: this.sessionAttributes
    },
    request: {
      requestId: this.requestId++,
      type: type,
      timestamp: Date.now()
    }
  };
},

quiet: function() {
  if (this.speechProcess) {
    this.speechProcess.kill('SIGINT');
  }
},

say: function(text) {
  this.quiet();
  this.speechProcess = ChildProcess.execFile(this.speechCommand.name,
    this.speechCommand.args.concat(text));

  this.speechProcess.on('exit', () => {
    this.speechProcess = null;
  });
},

createContext: function(skill) {
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
            this.say(speech.ssml);
            break;

          case 'PlainText':
            this.say(speech.text);
            break;

          default:
            console.warn('Unrecognised speech type: ' + speech.type);
        }
      }

      if (o.response.shouldEndSession) {
        this.endSession(skill);
      }
    }
  };
},

endSession: function(skill) {
  var event = this.createEvent('SessionEndedRequest');
  skill.module.handler(event, skill.context);
  delete skill.context;
  if (this.activeSkill === skill) {
    this.activeSkill = null;
    this.sleep();
  }
},

launch: function(skill, intent, slots, id) {
  if (id) {
    this.sessionId = id;
  }

  var newSkill = false;
  if (skill !== this.activeSkill) {
    if (this.activeSkill) {
      this.endSession(this.activeSkill);
    }
    this.sessionAttributes = {};
    skill.context = this.createContext(skill);
    newSkill = true;
  }
  var event = this.createEvent(newSkill ? 'LaunchRequest' : 'IntentRequest');
  event.session.new = newSkill;

  if (intent) {
    event.request.intent = { name: intent, slots: slots ? slots : {} };
  }

  skill.module.handler(event, skill.context);
},

listSkills: function() {
  for (var skill of this.skills) {
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
},

normaliseString: function(string) {
  return string.replace(/ +/, ' ').toLocaleLowerCase().trim();
},

normaliseCamelCase: function(string) {
  return this.normaliseString(string.replace(/([A-Z])/, ' $1'));
},

// Translate input text with a particular matched skill/intent with slot output
matchSlot: function(skill, intent, slotName, text) {
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
},

matchIntent: function(skill, intent, input) {
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
        var value = this.matchSlot(skill, intent, slotMatch.name,
                                   this.normaliseString(matchString));
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
},

lookupWords: function(string, decoder) {
  if (!decoder) {
    return true;
  }

  var wordsNotFound = [];
  for (var word of string.split(' ')) {
    if (word.length <= 0) {
      continue;
    }
    if (!decoder.lookupWord(word)) {
      wordsNotFound.push(word);
    }
  }

  if (wordsNotFound.length > 0) {
    var firstWord = true;
    for (var word of wordsNotFound) {
      if (this.warnWords[word]) {
        continue;
      }
      this.warnWords[word] = true;
      if (firstWord) {
        console.warn(`String '${string}' contains words not in dictionary:`);
        firstWord = false;
      }
      console.warn('\t' + word);
    }
    return false;
  }

  return true;
},

buildGrammar: function() {
  var grammar = '#JSGF V1.0;\ngrammar ferris;\n\n';

  // Add grammar for built-in commands
  grammar += this.enableBuiltins ?
    '<ferris.command> = exit | quit | help | list | grammar | stop ;\n\n' :
    '<ferris.command> = help | stop ;\n\n';

  // Add grammar for built-in slots
  grammar +=
    '<ferris.dateDaySingle> = first | second | third | fourth | fifth | ' +
    'sixth | seventh | eighth | ninth ;\n';
  grammar +=
    '<ferris.dateDay> = <ferris.dateDaySingle> | tenth | eleventh | ' +
    'twelfth | thirteenth | fourteenth | fifteenth | sixteenth | ' +
    'seventeenth | eighteenth | nineteenth | twentieth | ' +
    '( twenty <ferris.dateDaySingle> ) | thirtieth | ( thirty first ) ;\n';
  grammar +=
    '<ferris.dateMonth> = january | february | march | april | may | june | ' +
    'july | august | september | october | november | december ;\n';
  grammar +=
    '<AMAZON.DATE> = ' +
    '( [ the ] <ferris.dateDay> [ of ] <ferris.dateMonth> ) | ' +
    '( <ferris.dateMonth> [ the ] <ferris.dateDay> ) ;\n\n';

  // Add grammar for launching skills
  var foundSkill = false;
  var skillGrammar = '<ferris.launcher> = ';
  for (var skill of this.skills) {
    var normalised = this.normaliseCamelCase(skill.name);

    if (!this.lookupWords(normalised, this.decoder)) {
      continue;
    }

    skillGrammar += `launch ${normalised} | `;
    foundSkill = true;
  }
  if (foundSkill) {
    grammar += skillGrammar.slice(0, -2) + ';\n';
  }

  // Add grammar for given array of skills
  for (var skill of this.skills) {

    // Add grammar for custom slots
    if (skill.customSlots) {
      var firstSlot = true;
      for (var slotName in skill.customSlots) {
        if (skill.customSlots[slotName].length <= 0) {
          continue;
        }

        var foundSlot = false;
        var slotGrammar = `<${skill.name}.${slotName}> = `;
        for (var slotText of skill.customSlots[slotName]) {
          var normalised = this.normaliseString(slotText);

          // Verify the string is ok with the current dictionary
          if (!this.lookupWords(normalised, this.decoder)) {
            continue;
          }

          slotGrammar += `${normalised} | `;
          foundSlot = true;
        }
        if (foundSlot) {
          if (firstSlot) {
            grammar += '\n';
            firstSlot = false;
          }
          grammar += slotGrammar.slice(0, -2) + ';\n';
        }
      }
    }

    // Add grammar for intents
    for (var intentName in skill.intents) {
      var intent = skill.intents[intentName];
      if (skill !== this.activeSkill && !intent.persist) {
        continue;
      }
      if (!intent.utterances || intent.utterances.length <= 0) {
        continue;
      }

      var intentGrammars = `<${skill.name}.${intentName}> = `;
      for (var utterance of intent.utterances) {
        intentGrammar = utterance;

        for (var slotName in intent.slots) {
          if (intent.slots[slotName].startsWith('AMAZON.')) {
            intentGrammar = intentGrammar.replace(new RegExp(`{${slotName}}`),
              `<${intent.slots[slotName]}>`);
          } else {
            intentGrammar = intentGrammar.replace(new RegExp(`{${slotName}}`),
              `<${skill.name}.${intent.slots[slotName]}>`);
          }
        }

        // Normalise the parts of the string between slots
        var valid = true;
        var split = intentGrammar.split(/ *<[^>]*> */);
        var slots = intentGrammar.match(/<[^>]*>/g);
        var normalised = '';
        for (var word of split) {
          word = this.normaliseString(word);

          if (word.length > 0) {
            if (!this.lookupWords(word, this.decoder)) {
              valid = false;
            }

            normalised += `${word} `;
          }

          if (slots) {
            var slot = slots.shift();
            if (slot) {
              normalised += `${slot} `;
            }
          }
        }

        if (!valid) {
          continue;
        }

        intentGrammar = normalised.slice(0, -1);

        if (intentGrammar.length < 1) {
          continue;
        }

        intentGrammars += `( ${intentGrammar} ) | `;
      }
      grammar += intentGrammars.slice(0, -2) + ';\n';
    }
  }

  // Build the public rule
  grammar += '\npublic <ferris.input> = ( ';

  // Add commands
  grammar += this.activeSkill ?
    `<ferris.command>` :
    `<ferris.command> | <ferris.launcher>`;
  for (var skill of this.skills) {
    for (var intentName in skill.intents) {
      var intent = skill.intents[intentName];
      if (skill !== this.activeSkill && (this.activeSkill || !intent.persist)) {
        continue;
      }
      if (!intent.utterances || intent.utterances.length <= 0) {
        continue;
      }

      grammar += ` | <${skill.name}.${intentName}>`;
    }
  }

  grammar += ' ) ;\n';

  return grammar;
},

parseCommand: function(command, onexit) {
  command = this.normaliseString(command);
  var noop = () => {};

  switch (command.replace(/ .*$/, '')) {
    case 'exit':
    case 'quit':
      return onexit ? onexit : noop;

    case 'help':
    case 'list':
      return this.listSkills.bind(this);

    case 'launch':
      for (var skill of this.skills) {
        var skillName = command.replace(/launch /, '');
        if (skillName === this.normaliseString(skill.name) ||
            skillName === this.normaliseCamelCase(skill.name)) {
          return () => {
            if (this.activeSkill !== skill) {
              if (this.activeSkill) {
                this.endSession(this.activeSkill);
              }
              this.launch(skill);
              if (skill.context) {
                this.activeSkill = skill;
              }
            }
          };
        }
      }
      break;

    case 'grammar':
      return () => {
        console.log(this.buildGrammar());
      };

    case 'stop':
      return () => {
        if (this.activeSkill) {
          this.endSession(this.activeSkill);
        } else {
          console.log('No active skill');
        }
      };

    default:
      var testIntent = (skill, intentName) => {
        var result = this.matchIntent(skill, skill.intents[intentName],
                                      command);
        if (result) {
          return () => {
            this.launch(skill, intentName, result);
            if (skill.context) {
              this.activeSkill = skill;
            }
          };
        }
        return null;
      }
      if (this.activeSkill) {
        for (var intentName in this.activeSkill.intents) {
          var result = testIntent(this.activeSkill, intentName);
          if (result) {
            return result;
          }
        }
      }
      for (var skill of this.skills) {
        for (var intentName in skill.intents) {
          if (!skill.intents[intentName].persist) {
            continue;
          }
          var result = testIntent(skill, intentName);
          if (result) {
            return result;
          }
        }
      }
      break;
  }

  return null;
},

restartSTT: function(rebuildGrammar) {
  if (!this.decoder) {
    return;
  }

  this.decoder.endUtt();
  if (rebuildGrammar) {
    var grammar = this.buildGrammar();
    this.decoder.setJsgfString('ferris', grammar);
    this.decoder.setSearch('ferris');
  }

  this.noiseLevel = { average: 0, samples: 0 };
  this.speechMatch = null;
  this.speechMatchTime = this.speechSampleTime = Date.now();
  this.decoder.startUtt();
},

sleep: function() {
  if (!this.awake || !this.wakeWord || this.wakeWord.length <= 0) {
    return;
  }

  console.log('Going to sleep');

  if (this.wakeTimeout) {
    clearTimeout(this.wakeTimeout);
    this.wakeTimeout = null;
  }

  this.awake = false;
  this.wakeTimeout = null;
  if (this.activeSkill) {
    this.endSession(this.activeSkill);
  }

  this.decoder.endUtt();
  this.decoder.setSearch('wakeword');
  Wakeword.resume();
},

wakeUp: function(onwake) {
  if (this.wakeTimeout) {
    clearTimeout(this.wakeTimeout);
    this.wakeTimeout = null;
  }

  // Timeout the current active skill / require the wake-word again
  if (this.wakeWord && this.wakeWord.length) {
    this.wakeTimeout = setTimeout(() => {
      console.log('Timed out');
      this.wakeTimeout = null;
      this.sleep();
    }, this.wakeTime);
  }

  if (!this.awake) {
    console.log('Waking up');
    this.awake = true;
    onwake && onwake();
    this.restartSTT(true);
  }
},

listen: function(onwake, onexit) {
  var decode = data => {
    if (this.speechProcess) {
      // XXX: Quick dirty hack to stop timeouts during speech
      if (this.awake) {
        this.wakeUp();
      }

      // XXX: Quick dirty hack to stop listening during speech.
      if (!this.listenWhileSpeaking) {
        return;
      }
    }

    var now = Date.now();

    // Calculate noise level
    var sum = 0;
    for (var i = 0; i < data.length; i+= 2) {
      sum += Math.abs(data.readInt16LE(i));
    }
    this.noiseLevel.average =
      ((this.noiseLevel.average * this.noiseLevel.samples) + sum) /
      (this.noiseLevel.samples + data.length / 2);
    this.noiseLevel.samples += data.length / 2;

    // Pass data to decoder
    this.decoder.processRaw(data, false, false);
    var hyp = this.decoder.hyp();
    var newMatch = false;
    if (hyp && (Math.abs(hyp.bestScore) < this.matchThreshold) &&
        (!this.speechMatch || hyp.hypstr !== this.speechMatch.hypstr)) {
      this.speechMatchTime = now;
      if (this.speechMatch) {
        hyp.command = this.speechMatch.command;
      }
      this.speechMatch = hyp;
      newMatch = true;
    }

    if (!this.speechMatch && (now - this.speechMatchTime > 1500)) {
      // If we've gone over 1.5s without recognising anything, restart
      // speech processing.
      this.restartSTT(false);
    } else if (newMatch && this.noiseLevel.average > this.noiseThreshold) {
      // If we have a new speech match and the noise level is over the
      // threshold, see if it can be parsed into a command and store it.
      console.log(`Detected '${this.speechMatch.hypstr}' ` +
                  `(${this.speechMatch.bestScore}), ` +
                  `average noise: ${this.noiseLevel.average}`);

      var command = this.parseCommand(this.speechMatch.hypstr, onexit);
      if (command) {
        this.speechMatch.command = command;
        this.wakeUp();
      }
    } else if (this.speechMatch && this.speechMatch.command &&
               now - this.speechMatchTime > 750) {
      // If we successfully parsed a command and it hasn't changed in 750ms,
      // execute it and restart recognition.
      this.speechMatch.command();
      if (this.activeSkill) {
        this.wakeUp();
      }
      this.restartSTT(false);
    } else if (this.speechMatch &&
               now - this.speechMatchTime > 1500) {
      // If 1.5s has passed and we got a speech match, but couldn't parse it
      // into a command,restart speech recognition without rebuilding the
      // grammar.
      this.restartSTT(false);
    }
  };

  var recordCallback = (data) => {
    if (!this.awake) {
      this.decoder = Wakeword.decoder;
      this.decoder.startUtt();
      this.wakeUp();
    }

    decode(data);
  };

  if (this.wakeWord && this.wakeWord.length > 0) {
    Wakeword.listen([this.wakeWord], 0.87, recordCallback);
  } else {
    Wakeword.record(recordCallback);
  }
}
};

