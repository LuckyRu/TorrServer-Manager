    export const VERSION = '0.1.0';
    const scriptUrl = document.currentScript && document.currentScript.src ? document.currentScript.src : '';
    export const hubBase = scriptUrl.replace(/\/plugins\/[^/?]+\.js(?:\?.*)?$/i, '');
    export const searchRequests = [];
