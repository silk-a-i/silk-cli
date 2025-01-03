import { Command, program } from 'commander';
import inquirer from 'inquirer';
import { Task } from '../lib/task.js';
import { CliRenderer } from '../lib/renderers/cli.js';
import { Logger } from '../lib/logger.js';
import { loadConfig } from '../lib/config/load.js';
import { infoCommand } from './info.js';
import fs from 'fs';
import { CommandOptions } from '../lib/CommandOptions.js';
import { gatherContextInfo, resolveContent } from '../lib/fs.js';
import { createBasicTools } from '../lib/tools/basicTools.js';
import { execute, streamHandler } from '../lib/llm.js';
import { FileStats } from '../lib/stats.js';

class ChatCommand {
  constructor(options = new CommandOptions()) {
    this.options = options;
    this.logger = new Logger({
      verbose: options.verbose,
      ...options.logger
    });
    this.state = {
      config: null,
      options,
      history: [],
      files: [],
      system: '',
      model: ''
    };
    this.renderer = new CliRenderer({
      raw: options.raw,
      showStats: options.stats
    });
  }

  async init() {
    this.state.config = await loadConfig(this.options);
    const { config } = this.state;

    this.logger.debug(`Using provider: ${config.provider}`);
    this.logger.debug(`Using model: ${config.model}`);

    const { root } = config;
    if (root) {
      fs.mkdirSync(root, { recursive: true });
      process.chdir(root);
    }
    this.logger.info(`Project root: ${process.cwd()}`);

    this.logger.info('Starting chat mode (type "exit" to quit, "/info" for config)');

    this.chatProgram = new Command();
    this.chatProgram.exitOverride();

    this.setupCommands();
    this.askQuestion();
  }

  setupCommands() {
    this.chatProgram
      .command('exit')
      .description('Exit the chat')
      .action(() => {
        process.exit(0);
      });

    this.chatProgram
      .command('info')
      .alias('i')
      .description('Show config info')
      .action(async () => {
        await infoCommand();
      });

    this.chatProgram
      .command('model')
      .description('Select model')
      .action(async () => {
        const { model } = await inquirer.prompt([{
          type: 'list',
          name: 'model',
          message: 'Select model:',
          choices: this.state.config.models,
          default: this.state.config.model
        }]);
        this.state.config.model = model;
      });

    this.chatProgram
      .command('context')
      .alias('c')
      .description('List context')
      .action(async () => {
        const files = await gatherContextInfo(this.state.config.include, this.state.config);
        const stats = new FileStats();
        files.forEach(file => stats.addFile(file.path, null, file));
        stats.getSummary(this.logger, { showLargestFiles: 60 });
      });

    this.chatProgram
      .command('state')
      .alias('s')
      .description('Show internal state')
      .action(async () => {
        console.log(this.state);
      });

    this.chatProgram
      .command('clear')
      .description('Clear history')
      .action(async () => {
        this.state.history = [];
      });

    this.chatProgram
      .command('history')
      .alias('h')
      .description('Show chat history')
      .action(() => {
        if (!this.state.history?.length) {
          console.log('No chat history');
          return;
        }
        new Logger({ verbose: true }).messages(this.state.history);
      });
  }

  async handleCommand(input) {
    try {
      await this.chatProgram.parseAsync(input.split(' '), { from: 'user' });
      return true;
    } catch (err) {
      console.error(`Error: ${err.message}`);
      return false;
    }
  }

  async handlePrompt(input = "") {
    this.logger.prompt(input);

    const contextInfo = await gatherContextInfo(this.state.config.include);
    const context = await resolveContent(contextInfo);

    const tools = this.state.config.tools.length ? this.state.config.tools : [
      ...createBasicTools({
        output: this.state.config.output,
      }),
      ...this.state.config.additionalTools,
    ];
    const task = new Task({ prompt: input, context, tools });

    this.state.system = task.fullSystem;

    this.renderer.attach(task.toolProcessor);

    const messages = [
      { role: 'system', content: task.fullSystem },
      ...this.state.history,
      { role: 'user', content: task.render() }
    ];
    this.logger.info('message size:', JSON.stringify(messages).length);

    const { stream } = await execute(messages, this.state.config);
    const content = await streamHandler(stream, chunk => {
      task.toolProcessor.process(chunk);
    });

    this.renderer.cleanup();
    process.stdout.write('\n');

    return { content, currentTask: task };
  }

  async askQuestion() {
    try {
      const { input } = await inquirer.prompt([
        {
          type: 'input',
          name: 'input',
          message: '> ',
        },
      ]);

      this.handleQuestion(input);
    } catch (error) {
      if (error.name === 'ExitPromptError') {
        return;
      }
      console.error(`Error: ${error.message}`);
      this.askQuestion();
    }
  }

  async handleQuestion(input = "") {
    const trimmedInput = input.trim();
    if (trimmedInput.startsWith('/')) {
      await this.handleCommand(trimmedInput.substring(1));
      this.askQuestion();
      return;
    }

    try {
      this.state.history.push({ role: 'user', content: input });
      const { content, currentTask } = await this.handlePrompt(input);
      this.state.history.push({ role: 'assistant', content });

      const tasks = currentTask?.toolProcessor.queue;
      await Promise.all(tasks.map(async task => {
        try {
          return await task(this);
        } catch (error) {
          this.logger.error(`Error: ${error.message}`);
        }
      }));
    } catch (error) {
      this.logger.error(`Error: ${error.message}`);
    }
    this.askQuestion();
  }
}

export async function chatCommand(options = new CommandOptions()) {
  const chat = new ChatCommand(options);
  await chat.init();
}
