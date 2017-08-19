const identifierRegex = /^[a-zA-Z_$][a-zA-Z_$0-9]*$/;

/*
  If the part is a function, we need to get the actual value of the parameters.
  A parameter x or y in func(x, y) may be
    a) Assigned a value in one of the dicts
    b) OR should be treated as a string literal "x" or "y"
*/
function getArgumentValue(dicts) {
  return a =>
    a === "true" || a === "false"
      ? { value: a === "true" }
      : isNaN(a)
        ? identifierRegex.test(a)
          ? (() => {
              for (const dict of dicts) {
                if (typeof dict === "function") {
                  const val = dict(a);
                  if (val) {
                    return val;
                  }
                } else {
                  if (hasOwnProperty(dict, a)) {
                    return { value: dict[a] };
                  }
                }
              }
              return { value: a };
            })()
          : { error: `${a} is not a valid identifier.` }
        : { value: +a };
}

/*
    Split path expression into
      a) objects
      b) functions and their parameters
*/
function analyzePath(encodedPath, dicts) {
  //The path would be url encoded
  const path = decodeURI(encodedPath);
  const parts = path.indexOf(".") ? path.split(".") : [path];
  return parts.map(part => {
    const openingBracket = part.indexOf("(");
    const isFunction = openingBracket > -1;
    return isFunction
      ? (() => {
          const closingBracket = part.indexOf(")");
          const identifier = part.substring(0, openingBracket);
          const argsString = part.substring(openingBracket + 1, closingBracket);
          const args = argsString
            .split(",")
            .map(a => a.trim())
            .map(getArgumentValue(dicts));
          return { type: "function", identifier, args };
        })()
      : { type: "object", identifier: part };
  });
}

export class RoutingError {
  constructor(message, type) {
    this.message = message;
    this.type = type;
  }
}

function isIterable(gen) {
  return (
    (gen[Symbol.iterator] && typeof gen[Symbol.iterator] === "function") ||
    (Symbol.asyncIterator &&
      gen[Symbol.asyncIterator] &&
      typeof gen[Symbol.asyncIterator] === "function")
  );
}

function __isIterable(gen) {
  return gen.next && typeof gen.next === "function";
}

function hasOwnProperty(obj, prop) {
  return typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, prop);
}

export default async function route(
  _app,
  expression,
  dicts = [],
  options = {}
) {
  async function iterateToEnd(resultOrGenerator) {
    if (__isIterable(resultOrGenerator)) {
      const gen = resultOrGenerator;
      while (true) {
        const nextVal = await gen.next();
        if (options.onNextValue && !nextVal.done) {
          options.onNextValue(await nextVal.value);
        }
        if (nextVal.done) {
          return await nextVal.value;
        }
      }
    } else {
      return resultOrGenerator;
    }
  }

  const app = typeof _app === "function" ? _app() : _app;
  const additionalArgs = options.args || [];
  const parts = expression ? analyzePath(expression, dicts) : [];

  let obj,
    error,
    current = app;

  for (const part of parts) {
    obj = obj ? `${obj}.${part.identifier}` : `${part.identifier}`;
    if (typeof current !== "undefined") {
      if (options.modifyHandler) {
        current = options.modifyHandler(current, part.identifier);
      }
      if (hasOwnProperty(current, part.identifier)) {
        if (part.type === "function") {
          const fn = current[part.identifier];
          if (typeof fn === "function") {
            const resultOrGenerator = await fn.apply(
              current,
              options.prependArgs
                ? additionalArgs.concat(part.args.map(a => a.value))
                : part.args.map(a => a.value).concat(additionalArgs)
            );
            current = await iterateToEnd(resultOrGenerator);
          } else if (typeof fn === "undefined") {
            error = new RoutingError(
              "The requested path was not found.",
              "NOT_FOUND"
            );
            break;
          } else {
            error = new RoutingError(
              `${obj} is not a function. Was ${typeof fn}.`,
              "NOT_A_FUNCTION"
            );
            break;
          }
        } else {
          const ref = current[part.identifier];
          const resultOrGenerator = await (typeof ref === "function"
            ? ref.apply(current, additionalArgs)
            : ref);
          current = await iterateToEnd(resultOrGenerator);
        }
      } else {
        error = new RoutingError(
          "The requested path was not found.",
          "NOT_FOUND"
        );
        break;
      }
    } else {
      break;
    }
  }

  const finalResult = error
    ? error
    : hasOwnProperty(current, options.index)
      ? await (async () => {
          if (options.modifyHandler) {
            current = options.modifyHandler(current, options.index);
          }
          const resultOrGenerator =
            typeof current[options.index] === "function"
              ? current[options.index].apply(current, additionalArgs)
              : current[options.index];
          return await iterateToEnd(resultOrGenerator);
        })()
      : current;

  return await finalResult;
}
