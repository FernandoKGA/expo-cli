import findUp from 'find-up';
import * as path from 'path';
import resolveFrom from 'resolve-from';

import { ConfigPlugin } from './Config.types';
import { assert } from './Errors';
import { fileExists } from './Modules';
import { resolveConfigPluginExport } from './evalConfig';

type JSONPlugin = { resolve: string; props?: Record<string, any> };
type JSONPluginsList = (JSONPlugin | string)[];

// Default plugin entry file name.
const pluginFileName = 'app.config.js';

function findUpPackageJson(root: string): string {
  const packageJson = findUp.sync('package.json', { cwd: root });
  assert(packageJson, `No package.json found for module "${root}"`);
  return packageJson;
}

function resolvePluginForModule(projectRoot: string, modulePath: string): string {
  const resolved = resolveFrom.silent(projectRoot, modulePath);
  assert(
    resolved,
    `Failed to resolve plugin for module "${modulePath}" relative to "${projectRoot}"`
  );
  // If the modulePath is something like `@bacon/package/index.js` or `expo-foo/build/app`
  // then skip resolving the module `index.expo-plugin.js`
  if (moduleNameIsDirectFileReference(modulePath)) {
    return resolved;
  }
  return findUpPlugin(resolved);
}

// TODO: Test windows
function pathIsFilePath(name: string): boolean {
  // Matches lines starting with: . / ~/
  return !!name.match(/^(\.|~\/|\/)/g);
}

// TODO: If this doesn't work on windows, scrap it.
function moduleNameIsDirectFileReference(name: string): boolean {
  if (pathIsFilePath(name)) {
    return true;
  }

  // TODO: Use this on windows path.sep
  const slashCount = name.match(/\//g)?.length ?? 0;

  // Orgs (like @expo/config ) should have more than one slash to be a direct file.
  if (name.startsWith('@')) {
    return slashCount > 1;
  }

  // Regular packages should be considered direct reference if they have more than one slash.
  return slashCount > 0;
}

function resolveExpoPluginFile(root: string): string | null {
  // Find the expo plugin root file
  const pluginModuleFile = resolveFrom.silent(
    root,
    // use ./ so it isn't resolved as a node module
    `./${pluginFileName}`
  );

  // If the default expo plugin file exists use it.
  if (pluginModuleFile && fileExists(pluginModuleFile)) {
    return pluginModuleFile;
  }
  return null;
}

function findUpPlugin(root: string): string {
  // Get the closest package.json to the node module
  const packageJson = findUpPackageJson(root);
  // resolve the root folder for the node module
  const moduleRoot = path.dirname(packageJson);
  // use whatever the initial resolved file was ex: `node_modules/my-package/index.js` or `./something.js`
  return resolveExpoPluginFile(moduleRoot) ?? root;
}

function normalizeJSONPlugin(plugin: string | JSONPlugin): JSONPlugin {
  if (typeof plugin === 'string') {
    plugin = { resolve: plugin };
  } else if (plugin.props === undefined) {
    plugin.props = {};
  }

  return plugin;
}

function normalizeJSONPluginList(plugins?: JSONPluginsList): JSONPlugin[] {
  if (!plugins || !Array.isArray(plugins)) {
    return [];
  }

  return plugins.reduce<JSONPlugin[]>((prev, curr) => {
    prev.push(normalizeJSONPlugin(curr));
    return prev;
  }, []);
}

// Resolve the module function and assert type
function resolveConfigPluginFunction(projectRoot: string, pluginModulePath: string) {
  const moduleFilePath = resolvePluginForModule(projectRoot, pluginModulePath);
  const result = requirePluginFile(moduleFilePath, pluginModulePath);
  return resolveConfigPluginExport(result, moduleFilePath);
}

function requirePluginFile(filePath: string, pluginModulePath: string): any {
  try {
    return require(filePath);
  } catch (error) {
    // TODO: Improve error messages
    throw error;
    // const message = [
    //   'Failed to load static config plugin:',
    //   `├── resolve: ${pluginModulePath}`,
    //   `╰── module:  ${filePath}`,
    //   error.message,

    // ]
    //   .filter(Boolean)
    //   .join('\n');

    //   error.fileName
    // console.info(error);
    // throw new ConfigError(message, 'INVALID_PLUGIN');
  }
}

/**
 * Resolves static plugins array as config plugin functions.
 *
 * @param config
 * @param projectRoot
 */
const withStaticPlugins: ConfigPlugin = config => {
  // @ts-ignore
  const plugins = normalizeJSONPluginList(config.plugins);
  // Resolve and evaluate plugins
  for (const plugin of plugins) {
    assert(config._internal?.projectRoot, `Unexpected: projectRoot isn't defined`);
    const withStaticPlugin = resolveConfigPluginFunction(
      config._internal?.projectRoot,
      plugin.resolve
    );
    config = withStaticPlugin(config, plugin.props);
  }
  return config;
};

export const withStaticPlugin: ConfigPlugin<{
  plugin: string | JSONPlugin;
  fallback?: ConfigPlugin<{ _resolverError: Error } & any>;
}> = (config, props) => {
  const projectRoot = config._internal?.projectRoot;
  assert(projectRoot, `Unexpected: projectRoot isn't defined`);

  const plugin = normalizeJSONPlugin(props.plugin);
  // Ensure no one uses this property by accident.
  assert(
    !plugin.props?._resolverError,
    `Plugin property '_resolverError' is a reserved property of \`withStaticPlugin\``
  );

  let withPlugin: ConfigPlugin<unknown>;
  try {
    // Resolve and evaluate plugins.
    withPlugin = resolveConfigPluginFunction(projectRoot, plugin.resolve);
  } catch (error) {
    // If the static module failed to resolve, attempt to use a fallback.
    // This enables support for built-in plugins with versioned variations living in other packages.
    if (props.fallback) {
      if (!plugin.props) plugin.props = {};
      // Pass this to the fallback plugin for potential warnings about needing to install a versioned package.
      plugin.props._resolverError = error;
      withPlugin = props.fallback;
    } else {
      // If no fallback, throw the resolution error.
      throw error;
    }
  }
  // Execute the plugin.
  config = withPlugin(config, plugin.props);
  return config;
};

export default withStaticPlugins;
