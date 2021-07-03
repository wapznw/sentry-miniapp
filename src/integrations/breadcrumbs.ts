import { API, getCurrentHub, captureException } from '@sentry/core';
import { supportRequest, getMinaContext, supportNavigations, getCurrentPage, getPrevPage, getMinaApiList, MINA_APP_LIFE_CYCLE, isWxUnhandledPromiseError } from '../env';
import { Integration, Severity } from '@sentry/types';
import { getEventDescription, logger, isError, safeJoin, isMatchingPattern } from '@sentry/utils';

function fill(source: any, name: any, replacement: any) {
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

type IntegrationOptions = {
    console: Array<string> | boolean | undefined
    request: boolean | undefined
    navigation: boolean | undefined
    api: boolean | undefined
    lifecycle: boolean | undefined
    unhandleError: boolean | undefined
    realtimeLog: boolean | undefined
    filterApis: Array<string> | undefined
}

export class Breadcrumbs implements Integration {
    name: string;
    ctx: any;
    realtimeLogManager: any;
    private readonly options: IntegrationOptions;
    public static id: string = "Breadcrumbs";

    constructor(options: IntegrationOptions) {
        this.name = Breadcrumbs.id;
        this.ctx = getMinaContext();
        if (this.ctx.getRealtimeLogManager) {
            this.realtimeLogManager = this.ctx.getRealtimeLogManager();
        }
        this.options = {
            console: true,
            request: true,
            navigation: true,
            api: true,
            lifecycle: true,
            unhandleError: true,
            realtimeLog: true,
            ...options,
        };
    }

    instrumentConsole() {
        let watchFunctions = ['info', 'warn', 'error', 'log', 'debug'];
        let consoleFilterFunctions = this.options.console ? watchFunctions : [];
        if (Array.isArray(this.options.console)) {
            consoleFilterFunctions = this.options.console;
        }
        let realtimeLogFilterFunctions = this.options.realtimeLog ? ['warn', 'error', 'info'] : [];
        if (Array.isArray(this.options.realtimeLog)) {
            realtimeLogFilterFunctions = this.options.realtimeLog;
        }
        const captureUnhandleError = this.options.unhandleError;
        const realtimeLogManager = this.realtimeLogManager;
        watchFunctions.forEach(function (level) {
            if (!(level in console)) {
                return;
            }

            fill(console, level, function (originalConsoleLevel: any) {
                return function (...args: Array<any>) {
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

    instrumentMinaApi() {
        let apiList = getMinaApiList();
        if (Array.isArray(this.options.api)) {
            apiList = this.options.api;
        } else if (!this.options.api) {
            apiList = [];
        }
        apiList.forEach((api: any) => {
            if (this.options.filterApis && this.options.filterApis.includes(api)) {
                return
            }
            if (this.ctx[api] && typeof this.ctx[api] === 'function') {
                fill(this.ctx, api, (originalRequest: any) => {
                    return (...args: Array<any>) => {
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
                    };
                });
            }
        });
    }

    instrumentRequest() {
        if (!supportRequest()) {
            return;
        }

        fill(this.ctx, 'request', (originalRequest: any) => {
            return (requestOptions: any = {}) => {
                let method = requestOptions.method ? requestOptions.method.toUpperCase() : 'GET';
                let url = requestOptions.url;

                const client = getCurrentHub().getClient();
                const dsn = client && client.getDsn();
                if (dsn) {
                    const filterUrl = new API(dsn).getStoreEndpoint();
                    //todo include 
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
                    header: requestOptions.header,
                    dataType: requestOptions.dataType,
                    status_code: 0,
                };

                const originSuccess = requestOptions.success;
                const originFail = requestOptions.fail;

                requestOptions.success = (res: any) => {
                    if (originSuccess) {
                        originSuccess(res);
                    }
                    fetchData.status_code = res.statusCode;
                    
                    Breadcrumbs.addBreadcrumb(
                        {
                            category: 'response',
                            data: fetchData,
                            type: 'http',
                        }
                    );
                };

                requestOptions.fail = (error: any) => {
                    if (originFail) {
                        originFail(error);
                    }
                    Breadcrumbs.addBreadcrumb(
                        {
                            category: 'response',
                            data: fetchData,
                            level: Severity.Error,
                            type: 'http',
                        }
                    );
                };

                return originalRequest.call(this.ctx, requestOptions);
            };
        });
    }

    instrumentNavigation() {
        const supportList = supportNavigations();
        if (!supportList) {
            return;
        }

        const captureUrlChange = (to: any) => {
            let from = getCurrentPage();

            Breadcrumbs.addBreadcrumb({
                category: 'navigation',
                data: {
                    from,
                    to,
                },
            });
        };

        function historyReplacementFunction(originalHistoryFunction: Function) {
            return function (options: any = {}) {
                let to = options.url;
                if (!to && options.delta) {
                    to = getPrevPage(options.delta);
                }
                if (to) {
                    captureUrlChange(to);
                }
                //@ts-expect-error
                return originalHistoryFunction.call(this, options);
            };
        }

        supportList.forEach((api: any) => {
            fill(this.ctx, api, historyReplacementFunction);
        });
    }

    instrumentLifeCycle() {
        // eslint-disable-next-line
        const ctx = this.ctx;
        MINA_APP_LIFE_CYCLE.forEach((key: any) => {
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

    static addBreadcrumb(breadcrumb: any, hint?: any) {
        if (getCurrentHub().getIntegration(Breadcrumbs)) {
            getCurrentHub().addBreadcrumb(breadcrumb, hint);
        }
    }

    setupOnce() {
        if (this.options.console || (this.options.realtimeLog && this.realtimeLogManager)) {
            this.instrumentConsole();
        }
        if (this.options.navigation) {
            this.instrumentNavigation();
        }
        if (this.options.request) {
            this.instrumentRequest();
        }
        if (this.options.api) {
            this.instrumentMinaApi();
        }
        if (this.options.lifecycle) {
            this.instrumentLifeCycle();
        }
    }
}

function addSentryBreadcrumb(serializedData: any) {
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