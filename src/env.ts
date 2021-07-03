import { logger } from '@sentry/utils';

declare var wx: any
declare function getCurrentPages(): any;
declare function getApp(params: any): any;

// eslint-disable-next-line
let minaContext = typeof wx !== 'undefined' ? wx : {};
let systemInfo: any = null;
let minaApp: any = null;

export const MINA_SYSTEMINFO_TAGS = ['brand', 'model', 'language', 'version', 'system', 'platform', 'SDKVersion'];
export const MINA_APP_LIFE_CYCLE = ['onAppShow', 'onAppHide'];
export const MINA_PAGE_LIFE_CYCLE = ['onLoad', 'onShow', 'onHide', 'onUnload', 'onReady'];

export function setMinaContext(ctx: any) {
    minaContext = ctx;
}

export function getMinaContext() {
    return minaContext;
}

export function getMinaApiList() {
    return Object.keys(minaContext).filter((api) => {
        return typeof minaContext[api] === 'function';
    });
}

export function getSystemInfo() {
    try {
        return systemInfo || (systemInfo = minaContext.getSystemInfoSync());
    } catch (e) {
        logger.warn('getSystemInfoSync is undefined in minaContext');
        const rtn: any = {};
        MINA_SYSTEMINFO_TAGS.forEach((tag) => {
            rtn[tag] = 'unknow';
        });
        return rtn;
    }
}

export function supportRequest() {
    return !!minaContext.request;
}

export function supportNavigations() {
    const list = ['navigateBack', 'navigateTo', 'redirectTo', 'reLaunch', 'switchTab'].filter((api) => {
        return !!minaContext[api];
    });
    if (list.length > 0) {
        return list;
    } else {
        return null;
    }
}

export function getCurrentPage() {
    try {
        if (typeof getCurrentPages === 'function') {
            // eslint-disable-next-line
            const pages = getCurrentPages();
            return pages[pages.length - 1].route;
        }
        logger.warn('getCurrentPages is not function in global');
        return 'unknow';
    } catch (e) {
        return 'unknow';
    }
}

export function getPrevPage(delta: any) {
    try {
        if (typeof getCurrentPages === 'function') {
            // eslint-disable-next-line
            const pages = getCurrentPages();
            if (!delta) {
                delta = 1;
            }
            return pages[pages.length - 1 - delta].route;
        }
        logger.warn('getCurrentPages is not function in global');
        return 'unknow';
    } catch (e) {
        return 'unknow';
    }

}

export async function getMinaApp() {
    if (minaApp) {
        return minaApp;
    }
    return new Promise((resolve) => {
        function process() {
            // eslint-disable-next-line
            const app = getApp({
                allowDefault: true
            });
            if (app) {
                minaApp = app;
                resolve(app);
            } else {
                setTimeout(process, 20);
            }
        }
        process();
    });
}

export function supportStorage() {
    const list = ['setStorage', 'getStorageSync'].filter((api) => {
        return !!minaContext[api];
    });
    return list.length === 2;
}

export function supportLogManager() {
    return !!minaContext.getLogManager;
}

export function isWxUnhandledPromiseError(message: any) {
    if (message && typeof message === 'string' && /^(Unhandled|Uncaught)/i.test(message)) {
        return true;
    }
    return false;
}