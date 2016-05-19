var concat = require('concat');
var Fs = require('fs');
var Mic = require('mic');
var Path = require('path');

var skillsPath = Path.join(__dirname, 'skills');

function loadSkills() {
  var skills = [];
  Fs.readdirSync(skillsPath).forEach(path => {
    var skillDir = Path.join(skillsPath, file);
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
    var srcPath = Path.join(skillDir, 'index.js');
    try {
      var skill = {};
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
            skill.intents[intent].push(utterance);
            break;
          }
        }
      }

      skills.push(skill);
      console.log('Successfully loaded skill: ' + path);
    } catch(e) {
      console.error('Failed to load skill: ' + path);
    }
  });
  return skills;
}

var skills = loadSkills();
