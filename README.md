# Ferris

Ferris is an implementation of the Amazon Alexa skills JS API that functions entirely offline and with no proprietary software requirements. Behaviour and features may not be complete or correct, as the author does not have access to an Amazon Echo device.

## Example

Assuming your Alexa skills are located in a subdirectory of the current directory called 'skills', the following code will start a Ferris instance that allows access to those skills:

```
const Ferris = require('./index');
var skills = Ferris.loadSkills('skills');
Ferris.listen(skills, () => { rl.close(); });
```

## Usage

The following commands are available:
- `list | help`: Lists available skills and skill details
- `exit | quit`: Calls the `onquit` parameter given to `listen` or `parseCommand`.
- `launch <skill-name>`: Launches the specified skill.
- `grammar`: Displays the current JSGF grammar used for speech recognition.
- `stop`: Stops the currently active skill.

## Limitations

Pocketsphinx cannot recognise words that aren't in its dictionary. Skill names are derived from their CamelCase directory name and must consist of dictionary words. Built-in slots only have limited support, and are not as flexible as the same slots on the real Amazon Echo service (for now).
