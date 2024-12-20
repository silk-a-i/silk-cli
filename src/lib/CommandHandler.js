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
  constructor(options = {}) {
    this.options = new CommandOptions(options);
    this.logger = new Logger(this.options);
    this.executor = new TaskExecutor(this.options);
    this.limitChecker = new LimitChecker(options);
  }

  async execute(promptOrFile = "") {
    const { root, include, dry } = this.options;

    this.logger.info(JSON.stringify({ root, promptOrFile, options: this.options }, null, 2));

    const configRoot = path.dirname(this.options.configPath);
    const prompt = await extractPrompt(promptOrFile, configRoot);

    await this.setupRoot(root);
    this.logger.info(`Project root: ${process.cwd()}`);
    
    // Display prompt
    this.logger.prompt(prompt);

    // Get context info first for stats
    const contextInfo = await gatherContextInfo(include);
    
    // Display stats
    const stats = new FileStats();
    contextInfo.forEach(file => stats.addFile(file.path, null, file));
    stats.getSummary(this.logger);
  
    // Check limits
    try {
      contextInfo.forEach(file => this.limitChecker.checkFile(file.path, file.size));
    } catch (e) {
      console.log()
      this.logger.error(e.message);
      this.logger.hint('Reduce the context or increase the limits in the config file.');
      console.log()
      return;
    }

    // Now resolve full content
    const context = await resolveContent(contextInfo);

    const tools = createBasicTools({ 
      output: this.options.output,
    });

    const task = new Task({ prompt, context, tools });
    const renderer = new CliRenderer(this.options).attach(task.toolProcessor);

    if (!dry) {
      await this.executor.execute(task, this.options);
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
