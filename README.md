# Ferris

Ferris is an implementation of the Amazon Alexa skills JS API that functions entirely offline and with no proprietary software requirements. Behaviour and features may not be complete or correct, as the author does not have access to an Amazon Echo device.

## Example

Assuming your Alexa skills are located in a subdirectory of the current directory called 'skills', the following code will start a Ferris instance that allows access to those skills:

```
const Ferris = require('./index');
Ferris.loadSkills('skills');
Ferris.listen(() => { process.exit(0); });
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

## Differences / Extensions

Ferris does not require a 'wake' word to launch intents. Currently available input can be queried with the `grammar` command. Intents can have the boolean property `persist`, that when set to `true`, allows the intent to be launched at any time, without using the `launch` command first. It's best to make limited use of this functionality as a large grammar will reduce the chance of successful and accurate matches.
