// A global listener receives targeted events too. Scope document actions explicitly.
export function listenDocument(api,event,handler){const label=api.webviewWindow?.getCurrentWebviewWindow?.().label||api.window?.getCurrentWindow?.().label;return api.event.listen(event,handler,label?{target:{kind:'WebviewWindow',label}}:undefined);}
