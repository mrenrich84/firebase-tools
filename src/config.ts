"use strict";

import { FirebaseConfig } from "./firebaseConfig";

const _ = require("lodash");
const clc = require("cli-color");
const cjson = require("cjson");
const fs = require("fs-extra");
const path = require("path");

const detectProjectRoot = require("./detectProjectRoot").detectProjectRoot;
const { FirebaseError } = require("./error");
const fsutils = require("./fsutils");
const loadCJSON = require("./loadCJSON");
const parseBoltRules = require("./parseBoltRules");
const { promptOnce } = require("./prompt");
const { resolveProjectPath } = require("./projectPath");
const utils = require("./utils");

type PlainObject = Record<string, unknown>;

export class Config {
  static FILENAME = "firebase.json";
  static MATERIALIZE_TARGETS = [
    "database",
    "emulators",
    "firestore",
    "functions",
    "hosting",
    "storage",
    "remoteconfig",
  ];

  public options: any;
  public projectDir: string;
  public data: any = {};
  public defaults: any = {};
  public notes: any = {};

  private _src: any;

  constructor(src: any, options: any) {
    this.options = options || {};
    this.projectDir = options.projectDir || detectProjectRoot(options);
    this._src = src;

    if (this._src.firebase) {
      this.defaults.project = this._src.firebase;
      utils.logWarning(
        clc.bold('"firebase"') +
          " key in firebase.json is deprecated. Run " +
          clc.bold("firebase use --add") +
          " instead"
      );
    }

    if (_.has(this._src, "rules")) {
      _.set(this._src, "database.rules", this._src.rules);
    }

    Config.MATERIALIZE_TARGETS.forEach((target) => {
      if (_.get(this._src, target)) {
        _.set(this.data, target, this._materialize(target));
      }
    });

    // auto-detect functions from package.json in directory
    if (
      this.projectDir &&
      !this.get("functions.source") &&
      fsutils.fileExistsSync(this.path("functions/package.json"))
    ) {
      this.set("functions.source", "functions");
    }
  }

  _hasDeepKey(obj: PlainObject, key: string) {
    if (_.has(obj, key)) {
      return true;
    }

    for (const k in obj) {
      if (obj.hasOwnProperty(k)) {
        if (_.isPlainObject(obj[k]) && this._hasDeepKey(obj[k] as PlainObject, key)) {
          return true;
        }
      }
    }
    return false;
  }

  _materialize(target: string) {
    const val = _.get(this._src, target);
    if (_.isString(val)) {
      let out = this._parseFile(target, val);
      // if e.g. rules.json has {"rules": {}} use that
      const lastSegment = _.last(target.split("."));
      if (_.size(out) === 1 && _.has(out, lastSegment)) {
        out = out[lastSegment];
      }
      return out;
    } else if (_.isPlainObject(val) || _.isArray(val)) {
      return val;
    }

    throw new FirebaseError('Parse Error: "' + target + '" must be object or import path', {
      exit: 1,
    });
  }

  _parseFile(target: string, filePath: string) {
    const fullPath = resolveProjectPath(this.options, filePath);
    const ext = path.extname(filePath);
    if (!fsutils.fileExistsSync(fullPath)) {
      throw new FirebaseError("Parse Error: Imported file " + filePath + " does not exist", {
        exit: 1,
      });
    }

    switch (ext) {
      case ".json":
        if (target === "database") {
          this.notes.databaseRules = "json";
        } else if (target === "database.rules") {
          this.notes.databaseRulesFile = filePath;
          try {
            return fs.readFileSync(fullPath, "utf8");
          } catch (e) {
            if (e.code === "ENOENT") {
              throw new FirebaseError(`File not found: ${fullPath}`, { original: e });
            }
            throw e;
          }
        }
        return loadCJSON(fullPath);
      /* istanbul ignore-next */
      case ".bolt":
        if (target === "database") {
          this.notes.databaseRules = "bolt";
        }
        return parseBoltRules(fullPath);
      default:
        throw new FirebaseError(
          "Parse Error: " + filePath + " is not of a supported config file type",
          { exit: 1 }
        );
    }
  }

  get src(): FirebaseConfig {
    // TODO(samstern): We should do JSON Schema validation on this at load time
    // and then make the _src type stronger.
    return this._src as FirebaseConfig;
  }

  get(key: string, fallback?: any) {
    return _.get(this.data, key, fallback);
  }

  set(key: string, value: any) {
    return _.set(this.data, key, value);
  }

  has(key: string) {
    return _.has(this.data, key);
  }

  path(pathName: string) {
    const outPath = path.normalize(path.join(this.projectDir, pathName));
    if (_.includes(path.relative(this.projectDir, outPath), "..")) {
      throw new FirebaseError(clc.bold(pathName) + " is outside of project directory", { exit: 1 });
    }
    return outPath;
  }

  readProjectFile(p: string, options: any) {
    options = options || {};
    try {
      const content = fs.readFileSync(this.path(p), "utf8");
      if (options.json) {
        return JSON.parse(content);
      }
      return content;
    } catch (e) {
      if (options.fallback) {
        return options.fallback;
      }
      if (e.code === "ENOENT") {
        throw new FirebaseError(`File not found: ${this.path(p)}`, { original: e });
      }
      throw e;
    }
  }

  writeProjectFile(p: string, content: any) {
    if (typeof content !== "string") {
      content = JSON.stringify(content, null, 2) + "\n";
    }

    fs.ensureFileSync(this.path(p));
    fs.writeFileSync(this.path(p), content, "utf8");
  }

  askWriteProjectFile(p: string, content: any) {
    const writeTo = this.path(p);
    let next;
    if (fsutils.fileExistsSync(writeTo)) {
      next = promptOnce({
        type: "confirm",
        message: "File " + clc.underline(p) + " already exists. Overwrite?",
        default: false,
      });
    } else {
      next = Promise.resolve(true);
    }

    return next.then((result: boolean) => {
      if (result) {
        this.writeProjectFile(p, content);
        utils.logSuccess("Wrote " + clc.bold(p));
      } else {
        utils.logBullet("Skipping write of " + clc.bold(p));
      }
    });
  }

  public static load(options: any, allowMissing?: boolean) {
    const pd = detectProjectRoot(options);
    const filename = options.configPath || Config.FILENAME;
    if (pd) {
      try {
        const filePath = path.resolve(pd, path.basename(filename));
        const data = cjson.load(filePath);
        return new Config(data, options);
      } catch (e) {
        throw new FirebaseError(`There was an error loading ${filename}:\n\n` + e.message, {
          exit: 1,
        });
      }
    }

    if (allowMissing) {
      return null;
    }

    throw new FirebaseError("Not in a Firebase app directory (could not locate firebase.json)", {
      exit: 1,
    });
  }
}
