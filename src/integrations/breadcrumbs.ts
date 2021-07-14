import {API, captureException, getCurrentHub} from '@sentry/core';
import {Integration, Severity} from '@sentry/types';
import {getEventDescription, isError, isMatchingPattern, logger, safeJoin } from '@sentry/utils';

import {
  getCurrentPage,
  getMinaApiList,
  getMinaContext,
  getPrevPage,
  isWxUnhandledPromiseError,
  MINA_APP_LIFE_CYCLE,
  supportNavigations,
  supportRequest
} from '../env';

const fillKeys = (obj: any, keys: any[] = []): any => {
  if (!keys || !keys.length) return obj;
  let objCopy = Object.create(null)
  for (const objKey in obj) {
    if (obj.hasOwnProperty(objKey) && !keys.includes(objKey)) {
      objCopy[objKey] = obj[objKey]
    }
  }
  return objCopy
}

const fill = (source: any, name: any, replacement: any): any => {
  try {
    if (!(name in source) || (source[name]).__sentry__) {
      return;
    }
    const original = source[name];
    const wrapped = replacement(original);
    wrapped.__sentry__ = true;
    wrapped.__sentry_original__ = original;
    wrapped.__sentry_wrapped__ = wrapped;
    if (Object.defineProperties && Object.getOwnPropertyDescriptor) {
      const desp: any = Object.getOwnPropertyDescriptor(source, name);
      if (!desp.configurable) {
        throw new Error('unable to config');
      }
      Object.defineProperties(source, {
        [name]: {
          value: wrapped
        }
      });
    } else {
      source[name] = wrapped;
    }
  } catch (e) {
    logger.warn(`fail to reset property ${name}`);
  }
}

/** JSDoc */
interface IntegrationOptions {
  console: string[] | boolean | undefined;
  request: boolean | any | undefined;
  navigation: boolean | undefined;
  api: boolean | undefined;
  lifecycle: boolean | undefined;
  unhandleError: boolean | undefined;
  realtimeLog: boolean | undefined;
  filterApis: string[] | undefined;
}

/** JSDoc */
export class Breadcrumbs implements Integration {
  public name: string;
  public ctx: any;
  public realtimeLogManager: any;
  private readonly _options: IntegrationOptions;
  public static id: string = "Breadcrumbs";

  public constructor(options: IntegrationOptions) {
    this.name = Breadcrumbs.id;
    this.ctx = getMinaContext();
    if (this.ctx.getRealtimeLogManager) {
      this.realtimeLogManager = this.ctx.getRealtimeLogManager();
    }
    this._options = {
      console: true,
      navigation: true,
      api: true,
      lifecycle: true,
      unhandleError: true,
      realtimeLog: true,
      ...options,
    };
  }

  /** JSDoc */
  public instrumentConsole() {
    const watchFunctions = ['info', 'warn', 'error', 'log', 'debug'];
    let consoleFilterFunctions = this._options.console ? watchFunctions : [];
    if (Array.isArray(this._options.console)) {
      consoleFilterFunctions = this._options.console;
    }
    let realtimeLogFilterFunctions = this._options.realtimeLog ? ['warn', 'error', 'info'] : [];
    if (Array.isArray(this._options.realtimeLog)) {
      realtimeLogFilterFunctions = this._options.realtimeLog;
    }
    const captureUnhandleError = this._options.unhandleError;
    const realtimeLogManager = this.realtimeLogManager;
    watchFunctions.forEach(function (level: string): any {
      if (!(level in console)) {
        return;
      }

      fill(console, level, function (originalConsoleLevel: any) {
        return function (...args: any[]): any {
          if (consoleFilterFunctions.indexOf(level) > -1) {
            const breadcrumbData = {
              category: 'console',
              data: {
                extra: {
                  arguments: JSON.stringify(args),
                },
                logger: level,
              },
              level: Severity.fromString(level),
              message: safeJoin(args, ' '),
            };

            if (level === 'assert') {
              if (args[0] === false) {
                breadcrumbData.message = `Assertion failed: ${safeJoin(args.slice(1), ' ') || 'console.assert'}`;
                breadcrumbData.data.extra.arguments = JSON.stringify(args.slice(1));
              }
            }

            Breadcrumbs.addBreadcrumb(breadcrumbData, {
              input: args,
              level,
            });
          }

          if (realtimeLogFilterFunctions.indexOf(level) > -1 && realtimeLogManager) {
            let _level = level;
            if (_level === 'log') {
              _level = 'info';
            }
            // tslint:disable-next-line:no-unused-expression
            realtimeLogManager[_level] && realtimeLogManager[_level].apply(realtimeLogManager, args);
          }

          if ((level === 'warn' || level === 'error') && captureUnhandleError) {
            if (isWxUnhandledPromiseError(args[0]) && isError(args[1])) {
              captureException(args[1]);
            }
          }

          if (originalConsoleLevel) {
            try {
              Function.prototype.apply.call(originalConsoleLevel, console, args);
            } catch (e) {
              originalConsoleLevel.apply(console, args);
            }
          }
        };
      });
    });
  }

  /** JSDoc */
  public instrumentMinaApi(): void {
    let apiList = getMinaApiList();
    if (Array.isArray(this._options.api)) {
      apiList = this._options.api;
    } else if (!this._options.api) {
      apiList = [];
    }
    apiList.forEach((api: any) => {
      if (this._options.filterApis && this._options.filterApis.includes(api)) {
        return
      }
      if (this.ctx[api] && typeof this.ctx[api] === 'function') {
        fill(this.ctx, api, (originalRequest: any) =>
          (...args: any[]) => {
            Breadcrumbs.addBreadcrumb(
              {
                category: 'mina-api',
                data: {
                  args,
                  name: api
                }
              }
            );
            return originalRequest.apply(this.ctx, args);
          });
      }
    });
  }

  /** JSDoc */
  public instrumentRequest(): void {
    if (!supportRequest()) {
      return;
    }

    fill(this.ctx, 'request', (originalRequest: any) =>
      (requestOptions: any = {}) => {
        const method = requestOptions.method ? requestOptions.method.toUpperCase() : 'GET';
        const url = requestOptions.url;

        const client = getCurrentHub().getClient();
        const dsn = client && client.getDsn();
        if (dsn) {
          const filterUrl = new API(dsn).getStoreEndpoint();
          if (filterUrl && isMatchingPattern(url, filterUrl)) {
            if (method === 'POST' && requestOptions.data) {
              addSentryBreadcrumb(requestOptions.data);
            }
            return originalRequest.call(this.ctx, requestOptions);
          }
        }
        const fetchData = {
          method,
          url,
          header: fillKeys(requestOptions.header, this._options.request?.filterHeaders || []),
          dataType: requestOptions.dataType,
          status_code: 0,
          requestData: requestOptions.data,
        };

        const originSuccess = requestOptions.success;
        const originFail = requestOptions.fail;

        requestOptions.success = (res: any) => {
          fetchData.status_code = res.statusCode;
          let data = res && typeof res.data === 'string' ? (res.data?.length > 128 ? res.data?.substr(0, 128) + '...' : res.data) : null;
          Breadcrumbs.addBreadcrumb(
            {
              category: 'request',
              data: {
                ...fetchData,
                response: {
                  header: fillKeys(res.header, this._options.request?.filterHeaders || []),
                  data,
                },
              },
              type: 'http',
            }
          );
          if (originSuccess) {
            originSuccess(res);
          }
        };

        requestOptions.fail = (error: any) => {
          Breadcrumbs.addBreadcrumb(
            {
              category: 'request',
              data: fetchData,
              level: Severity.Error,
              type: 'http',
            }
          );
          if (originFail) {
            originFail(error);
          }
        };

        return originalRequest.call(this.ctx, requestOptions);
      });
  }

  /** JSDoc */
  public instrumentNavigation(): void {
    const supportList = supportNavigations();
    if (!supportList) {
      return;
    }

    const captureUrlChange = (to: any) => {
      const from = getCurrentPage();

      Breadcrumbs.addBreadcrumb({
        category: 'navigation',
        data: {
          from,
          to,
        },
      });
    };

    function historyReplacementFunction(originalHistoryFunction: Function): Function {
      return function (options: any = {}): any {
        let to = options.url;
        if (!to && options.delta) {
          to = getPrevPage(options.delta);
        }
        if (to) {
          captureUrlChange(to);
        }
        // @ts-expect-error
        return originalHistoryFunction.call(this, options);
      };
    }

    supportList.forEach((api: any) => {
      fill(this.ctx, api, historyReplacementFunction);
    });
  }

  public instrumentLifeCycle() {
    const ctx: any = this.ctx;
    MINA_APP_LIFE_CYCLE.forEach((key: any) => {
      // tslint:disable-next-line:no-unused-expression
      ctx[key] && ctx[key]((res: any) => {
        Breadcrumbs.addBreadcrumb({
          category: 'app-life-cycle',
          data: {
            name: key,
            args: res
          },
        });
      });
    });
  }

  /** JSDoc */
  public static addBreadcrumb(breadcrumb: any, hint?: any): void {
    if (getCurrentHub().getIntegration(Breadcrumbs)) {
      getCurrentHub().addBreadcrumb(breadcrumb, hint);
    }
  }

  /** JSDoc */
  public setupOnce(): void {
    if (this._options.console || (this._options.realtimeLog && this.realtimeLogManager)) {
      this.instrumentConsole();
    }
    if (this._options.navigation) {
      this.instrumentNavigation();
    }
    if (this._options.request) {
      this.instrumentRequest();
    }
    if (this._options.api) {
      this.instrumentMinaApi();
    }
    if (this._options.lifecycle) {
      this.instrumentLifeCycle();
    }
  }
}

/** JSDoc */
function addSentryBreadcrumb(serializedData: any): void {
  try {
    const event = JSON.parse(serializedData);
    Breadcrumbs.addBreadcrumb(
      {
        category: 'sentry',
        event_id: event.event_id,
        level: event.level || Severity.fromString('error'),
        message: getEventDescription(event),
      },
      {
        event,
      },
    );
  } catch (_oO) {
    logger.error('Error while adding sentry type breadcrumb');
  }
}
