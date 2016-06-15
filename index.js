const Concat = require('concat-stream');
const ChildProcess = require('child_process');
const Fs = require('fs');
const Mic = require('mic');
const Nlp = require('nlp_compromise');
const Path = require('path');
const PocketSphinx = require('pocketsphinx').ps;
const Which = require('which');

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

// Words not in the pocketsphinx dictionary that we've warned on the console
warnWords: {},

// Wake-word variables
wakeWord: 'ferris',
wakeTime: 5000,
wakeTimeout: null,
awake: false,

// Enable/disable built-in commands via speech
enableBuiltins: true,

// Speech input properties
decoder: null,
mic: null,
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

  // TODO: Add grammar for built-in slots

  // Add grammar for built-in commands
  grammar += this.enableBuiltins ?
    '<ferris.command> = exit | quit | help | list | grammar | stop ;\n' :
    '<ferris.command> = help | stop ;\n';

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
    grammar += '\n';

    // Add grammar for custom slots
    if (skill.customSlots) {
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
          intentGrammar = intentGrammar.replace(new RegExp(`{${slotName}}`),
            `<${skill.name}.${intent.slots[slotName]}>`);
        }

        // Normalise the parts of the string between slots
        var valid = true;
        var split = intentGrammar.split(/ *<[^>]*> */);
        var slots = intentGrammar.match(/<[^>]*>/g);
        var normalised = '';
        for (var word of split) {
          word = this.normaliseString(word);

          if (!this.lookupWords(word, this.decoder)) {
            valid = false;
          }

          normalised += `${word} `;

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
        intentGrammars += `${intentGrammar} | `;
      }
      grammar += intentGrammars.slice(0, -2) + ';\n';
    }
  }

  // Build the public rule
  // Add wake word
  grammar += '\npublic <ferris.input> = ';
  var wakeWord = '';
  if (!this.awake && (this.wakeWord && this.wakeWord.length > 0)) {
    if (!this.decoder.lookupWord(this.wakeWord)) {
      console.warn('Wake word \'' + this.wakeWord +
                   '\' not present in dictionary, disabling wake word');
      this.wakeWord = '';
    } else {
      grammar += `${this.wakeWord} | `;
      wakeWord = this.wakeWord + ' ';
    }
  }

  // Add commands
  grammar += `${wakeWord}<ferris.command> | ${wakeWord}<ferris.launcher>`;
  for (var skill of this.skills) {
    for (var intentName in skill.intents) {
      var intent = skill.intents[intentName];
      if (skill !== this.activeSkill && !intent.persist) {
        continue;
      }
      if (!intent.utterances || intent.utterances.length <= 0) {
        continue;
      }

      grammar += ` | ${wakeWord}<${skill.name}.${intentName}>`;
    }
  }
  grammar += ' ;\n';

  return grammar;
},

parseCommand: function(command, onexit) {
  command = this.normaliseString(command);

  switch (command.replace(/ .*$/, '')) {
    case 'exit':
    case 'quit':
      if (onexit) {
        onexit();
      }
      break;

    case 'help':
    case 'list':
      this.listSkills();
      break;

    case 'launch':
      var matched = false;
      for (var skill of this.skills) {
        var skillName = command.replace(/launch /, '');
        if (skillName === this.normaliseString(skill.name) ||
            skillName === this.normaliseCamelCase(skill.name)) {
          if (this.activeSkill !== skill) {
            if (this.activeSkill) {
              this.endSession(this.activeSkill);
            }
            this.launch(skill);
            if (skill.context) {
              this.activeSkill = skill;
            }
            matched = true;
            break;
          }
        }
      }
      if (!matched) {
        return false;
      }
      break;

    case 'grammar':
      console.log(this.buildGrammar());
      break;

    case 'stop':
      if (this.activeSkill) {
        this.endSession(this.activeSkill);
      } else {
        console.log('No active skill');
      }
      break;

    default:
      var testIntent = (skill, intentName) => {
        var result = this.matchIntent(skill, skill.intents[intentName],
                                      command);
        if (result) {
          this.launch(skill, intentName, result);
          if (skill.context) {
            this.activeSkill = skill;
          }
          return true;
        }
        return false;
      }
      if (this.activeSkill) {
        for (var intentName in this.activeSkill.intents) {
          if (testIntent(this.activeSkill, intentName)) {
            return true;
          }
        }
      }
      for (var skill of this.skills) {
        for (var intentName in skill.intents) {
          if (!skill.intents[intentName].persist) {
            continue;
          }
          if (testIntent(skill, intentName)) {
            return true;
          }
        }
      }
      return false;
  }

  return true;
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

wakeUp: function(onwake) {
  if (!this.awake) {
    console.log('Waking up');
    this.awake = true;
    onwake && onwake();
  }

  if (this.wakeTimeout) {
    clearTimeout(this.wakeTimeout);
  }

  // Timeout the current active skill / require the wake-word again
  this.wakeTimeout = setTimeout(() => {
    console.log('Timed out, going to sleep');
    this.awake = false;
    this.wakeTimeout = null;
    if (this.activeSkill) {
      this.endSession(this.activeSkill);
    }
    this.restartSTT(true);
  }, this.wakeTime);

  this.restartSTT(true);
},

listen: function(onwake, onexit) {
  // Not happy about needing to do this. Running pocketsphinx from the
  // command-line finds the default models automatically.
  Which('pocketsphinx_continuous', (e, path) => {
    if (e) {
      console.error('Error searching for pocketsphinx', e);
      return;
    }

    path = Path.join(Path.dirname(path), '..', 'share',
                     'pocketsphinx', 'model', 'en-us');
    if (!Fs.statSync(path).isDirectory()) {
      console.error('Pocketsphinx en-us model not found at ' + path);
      return;
    }

    var config = PocketSphinx.Decoder.defaultConfig();
    config.setString("-hmm", Path.join(path, 'en-us'));
    config.setString("-dict", Path.join(path, 'cmudict-en-us.dict'));
    config.setString("-lm", Path.join(path, 'en-us.lm.bin'));
    config.setString('-logfn', '/dev/null');

    this.decoder = new PocketSphinx.Decoder(config);
    this.decoder.startUtt();
    this.restartSTT(true);

    // Setup microphone and start streaming to the decoder
    this.mic = Mic(
      { rate: '16000',
        channels: '1',
        encoding: 'signed-integer',
        device: 'default' });

    var buffer = Concat(decode);
    var stream = this.mic.getAudioStream();

    var decode = data => {
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
      if (hyp && (Math.abs(hyp.bestScore) < this.matchThreshold) &&
          (!this.speechMatch || hyp.hypstr !== this.speechMatch.hypstr)) {
        this.speechMatchTime = Date.now();
        this.speechMatch = hyp;
      }

      if (!this.speechMatch || this.noiseLevel.average <= this.noiseThreshold) {
        if (Date.now() - this.speechMatchTime > 1500) {
          /*console.log(`Silence detected (${this.noiseLevel.average}), ` +
                      `restarting STT`);*/
          if (!this.awake && this.speechMatch &&
              this.speechMatch.hypstr.startsWith(this.wakeWord + ' ')) {
            this.wakeUp(onwake);
          } else {
            this.restartSTT(false);
          }
        } else {
          /*console.log(`Silence detected (${this.noiseLevel.average}) ` +
                      `over a short period`);*/
        }
      } else if (Date.now() - this.speechMatchTime > 750) {
        console.log(`Detected '${this.speechMatch.hypstr}' ` +
                    `(${this.speechMatch.bestScore}), ` +
                    `average noise: ${this.noiseLevel.average}`);
        var commandExecuted = false;
        var justWakeWord = false;

        if (!this.awake && this.wakeWord && this.wakeWord.length > 0) {
          var wakeWord = this.wakeWord + ' ';
          if (this.speechMatch.hypstr === this.wakeWord) {
            commandExecuted = true;
            justWakeWord = true;
          } else if (this.speechMatch.hypstr.startsWith(wakeWord)) {
            var speechMatch = this.speechMatch.hypstr.replace(wakeWord, '');
            commandExecuted = this.parseCommand(speechMatch, onexit);
          }
        } else {
          commandExecuted = this.parseCommand(this.speechMatch.hypstr, onexit);
        }
        if (commandExecuted) {
          this.wakeUp(justWakeWord ? onwake : null);
        } else if (Date.now() - this.speechMatchTime > 1500) {
          this.restartSTT(true);
        }
      }
    };

    stream.on('data', data => {
      // XXX: Quick dirty hack to stop listening during speech.
      if (this.speechProcess) {
        return;
      }

      buffer.write(data);
      if (Date.now() - this.speechSampleTime > 300) {
        buffer.end();
        this.speechSampleTime = Date.now();
        buffer = Concat(decode);
      }
    });
    stream.on('error', e => {
      console.error('Error streaming from microphone', e);
    });

    this.mic.start();
  });
}
};

