import { Logger } from './logger.js';
import { TaskExecutor } from './TaskExecutor.js';
import { Task } from './task.js';
import { CliRenderer } from './renderers/cli.js';
import { extractPrompt } from './prompt-extractor.js';
import { createBasicTools } from './tools/basicTools.js';
import { gatherContextInfo, resolveContent } from './utils.js';
import { FileStats } from './stats.js';
import { CommandOptions } from './CommandOptions.js';
import { LimitChecker } from './LimitChecker.js';
import fs from 'fs';
import path from 'path';

export class CommandHandler {
  logger = new Logger();
  options = new CommandOptions();
  executor = new TaskExecutor();
  limitChecker = new LimitChecker();

  constructor(options = {}) {
    this.options = new CommandOptions(options);
    if (typeof options.logger === 'object') {
      this.logger = new Logger(options.logger);
    } else {
      this.logger = options.logger || new Logger({
        verbose: options.verbose,
      });
    }
    this.executor = new TaskExecutor(this.options);
    this.limitChecker = new LimitChecker(options);
  }

  async execute(promptOrFile = "") {
    const { root, include, dry } = this.options;
    const { logger } = this;

    logger.info(JSON.stringify({ root, promptOrFile, options: this.options }, null, 2));

    const configRoot = path.dirname(this.options.configPath);
    const prompt = await extractPrompt(promptOrFile, configRoot);

    await this.setupRoot(root);
    logger.info(`Project root: ${process.cwd()}`);

    // Display prompt
    logger.prompt(prompt);

    // Get context info first for stats
    const contextInfo = await gatherContextInfo(include);

    // Display stats
    const stats = new FileStats();
    contextInfo.forEach(file => stats.addFile(file.path, null, file));
    stats.getSummary(logger);

    // Check limits
    try {
      contextInfo.forEach(file => this.limitChecker.checkFile(file.path, file.size));
    } catch (e) {
      console.log()
      logger.error(e.message);
      logger.hint('Reduce the context or increase the limits in the config file.');
      console.log()
      return;
    }

    // Now resolve full content
    const context = await resolveContent(contextInfo);

    const tools = this.options.tools || [
      ...createBasicTools({
        output: this.options.output,
      }),
      ...this.options.additionalTools,
    ]

    const task = new Task({ prompt, context, tools });
    const renderer = new CliRenderer(this.options).attach(task.toolProcessor);

    if (!dry) {
      const resp = await this.executor.execute(task);

      const MOCK_STATE = {
        history: [],
      }
      const state = MOCK_STATE
      
      // Any tasks in the queue?
      const tasks = resp.currentTask?.toolProcessor.queue;
      const responses = await Promise.all(tasks.map(async task => {
        try {
          return await task(state)
        } catch (error) {
          logger.error(`Error: ${error.message}`);
        }
      }))
    }

    renderer.cleanup();
  }

  async setupRoot(root) {
    if (root) {
      fs.mkdirSync(root, { recursive: true });
      process.chdir(root);
    }
  }
}
