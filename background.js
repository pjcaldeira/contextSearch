/// Global variables
var searchEngines = {};
var searchEnginesArray = [];
var selection = "";
var targetUrl = "";

/// Constants
const DEFAULT_JSON = "defaultSearchEngines.json";

/// Browser specifics
var reset = false;
let browserVersion = 45;

/// Preferences
let contextsearch_openSearchResultsInNewTab = true;
let contextsearch_makeNewTabOrWindowActive = false;
let contextsearch_openSearchResultsInNewWindow = false;

/// Handle Incoming Messages
// Listen for messages from the content or options script
browser.runtime.onMessage.addListener(function(message) {
    switch (message.action) {
        case "notify":
            notify(message.data);
            break;
        case "getSelectionText":
            if (message.data) selection = message.data;
            break;
        case "sendCurrentTabUrl":
            if (message.data) targetUrl = message.data;
            break;
        case "reset":
            reset = true;
            loadSearchEngines(DEFAULT_JSON);
            break;
        default:
            break;
    }
});

/// Initialisation
function init() {
	detectStorageSupportAndLoadSearchEngines();
    browser.runtime.getBrowserInfo().then(gotBrowserInfo);
    browser.storage.onChanged.addListener(onStorageChanges);

    rebuildContextMenu();

    browser.storage.local.get(["tabMode", "tabActive"]).then(setTabMode, onNone);

    // getBrowserInfo
    function gotBrowserInfo(info){
        let v = info.version;
        browserVersion = parseInt(v.slice(0, v.search(".") - 1));
    }
}

// Store the default values for tab mode in storage local
function onNone() {
    let data = {};
    data["tabMode"] = "openNewTab";
    data["tabActive"] = false;
    browser.storage.local.set(data);
    setTabMode(data);
}

// To support Firefox ESR, we should check whether browser.storage.sync is supported and enabled.
function detectStorageSupportAndLoadSearchEngines() {
	browser.storage.sync.get(null).then(onGot, onFallback);

    // Load search engines if they're not already loaded in storage sync
	function onGot(searchEngines){
        if (!Object.keys(searchEngines).length > 0 || reset) {
            // Storage sync is empty -> load default list of search engines
            loadSearchEngines(DEFAULT_JSON);
        }
	}

	function onFallback(error){
        loadSearchEngines(DEFAULT_JSON);
		if (error.toString().indexOf("Please set webextensions.storage.sync.enabled to true in about:config") > -1) {
			notify("Please enable storage sync by setting webextensions.storage.sync.enabled to true in about:config. Context Search will not work until you do so.");
		} else {
            onError(error);
        }
	}
}

/// Load default list of search engines
function loadSearchEngines(jsonFile) {
    let xhr = new XMLHttpRequest();
    xhr.open("GET", jsonFile, true);
    xhr.setRequestHeader("Content-type", "application/json");
    xhr.overrideMimeType("application/json");
    xhr.onreadystatechange = function() {
        if (this.readyState == 4 && this.status == 200) {
            notify("Default list of search engines has been loaded.");
            var searchEngines = JSON.parse(this.responseText);
            browser.storage.sync.set(searchEngines).then(function() {
                rebuildContextMenu();
                if (reset) {
                    browser.runtime.sendMessage({"action": "searchEnginesLoaded", "data": searchEngines}).then(null, onError);
                    reset = false;
                }
            }, onError);
        }
    };
    xhr.send();
}

/// Build a single context menu item
function buildContextMenuItem(searchEngine, id, title, faviconUrl){
    const contexts = ["selection"];

    if (!searchEngine.show) return;

    if (browserVersion > 55){
        browser.contextMenus.create({
            id: id,
            title: title,
            contexts: contexts,
            icons: { 18: faviconUrl }
        });
    } else {
        browser.contextMenus.create({
            id: id,
            title: title,
            contexts: contexts
        });
    }
}

/// Handle Storage Changes
function onStorageChanges(changes, area) {
    if (area === "sync") {
        rebuildContextMenu();
    } else if (area === "local") {
        browser.storage.local.get(["tabMode", "tabActive"]).then(setTabMode, onError);
    }
}

/// Tab Mode
function setTabMode(data) {
    contextsearch_makeNewTabOrWindowActive = data.tabActive;
    switch (data.tabMode) {
        case "openNewTab":
            contextsearch_openSearchResultsInNewTab = true;
            contextsearch_openSearchResultsInNewWindow = false;
            break;
        case "sameTab":
            contextsearch_openSearchResultsInNewTab = false;
            contextsearch_openSearchResultsInNewWindow = false;
            break;
        case "openNewWindow":
            contextsearch_openSearchResultsInNewWindow = true;
            contextsearch_openSearchResultsInNewTab = false;
            break;
        default:
            break;
    }
}

/// Rebuild the context menu using the search engines from storage sync
function rebuildContextMenu() {
    browser.contextMenus.removeAll();
    browser.contextMenus.onClicked.removeListener(processSearch);
    browser.contextMenus.create({
        id: "cs-google-site",
        title: "Search this site with Google",
        contexts: ["selection"]
    });
    browser.contextMenus.create({
        id: "cs-options",
        title: "Options...",
        contexts: ["selection"]
    });
    browser.contextMenus.create({
        id: "cs-separator",
        type: "separator",
        contexts: ["selection"]
    });

    browser.storage.sync.get(null).then(
        (data) => {
            searchEngines = sortByIndex(data);
            searchEnginesArray = [];
            var index = 0;
            for (var id in searchEngines) {
                var strId = "cs-" + index.toString();
                var strTitle = searchEngines[id].name;
                var url = searchEngines[id].url;
                var faviconUrl = "https://s2.googleusercontent.com/s2/favicons?domain_url=" + url;
                searchEnginesArray.push(id);
                buildContextMenuItem(searchEngines[id], strId, strTitle, faviconUrl);
                index += 1;
            }
        }
    );

    browser.contextMenus.onClicked.addListener(processSearch);
}

/// Sort search engines by index
function sortByIndex(list) {
    var sortedList = {};
    var skip = false;
    
    // If there are no indexes, then add some arbitrarily
    for (var i = 0;i < Object.keys(list).length;i++) {
		var id = Object.keys(list)[i];
		if (list[id].index != null) {
			break;
		} 
		if (list[id] != null) {
			sortedList[id] = list[id];
			sortedList[id]["index"] = i;
			skip = true;
		}
    }

    for (var i = 0;i < Object.keys(list).length;i++) {
      for (let id in list) {
        if (list[id] != null && list[id].index === i) {
          sortedList[id] = list[id];
        }
      }
    }
    return sortedList;
}

// Perform search based on selected search engine, i.e. selected context menu item
function processSearch(info, tab){
    let id = info.menuItemId.replace("cs-", "");

    // Prefer info.selectionText over selection received by content script for these lengths (more reliable)
    if (info.selectionText.length < 150 || info.selectionText.length > 150) {
        selection = info.selectionText;
    }

    if (id === "google-site" && targetUrl != "") {
        displaySearchResults(targetUrl, tab.index);
        targetUrl = "";
        return;
    } else if (id === "options") {
        browser.runtime.openOptionsPage().then(null, onError);
        return;
    }

    id = parseInt(id);
    
    // At this point, it should be a number
    if(!isNaN(id)){
		let searchEngineUrl = searchEngines[searchEnginesArray[id]].url;
        if (searchEngineUrl.includes("{search terms}")) {
            targetUrl = searchEngineUrl.replace("{search terms}", encodeURIComponent(selection));
        } else if (searchEngineUrl.includes("%s")) {
			targetUrl = searchEngineUrl.replace("%s", encodeURIComponent(selection));
        } else {
            targetUrl = searchEngineUrl + encodeURIComponent(selection);
        }
        displaySearchResults(targetUrl, tab.index);
        targetUrl = "";
    }    
}

/// Helper functions
function displaySearchResults(targetUrl, tabPosition) {
    browser.windows.getCurrent({populate: false}).then(function(windowInfo) {
        var currentWindowID = windowInfo.id;
        if (contextsearch_openSearchResultsInNewWindow) {
            browser.windows.create({
                url: targetUrl
            }).then(function() {
                if (!contextsearch_makeNewTabOrWindowActive) {
                    browser.windows.update(currentWindowID, {
                        focused: true
                    }).then(null, onError);    
                }
            }, onError);
        } else if (contextsearch_openSearchResultsInNewTab) {
            browser.tabs.create({
                active: contextsearch_makeNewTabOrWindowActive,
                index: tabPosition + 1,
                url: targetUrl
            });
        } else {
            // Open search results in the same tab
            console.log("Opening search results in same tab");
            browser.tabs.update({url: targetUrl});
        }
    }, onError);
}

function onError(error) {
    console.log(`${error}`);
}

function notify(message){
    browser.notifications.create(message.substring(0, 20),
    {
        type: "basic",
        iconUrl: browser.extension.getURL("icons/icon_96.png"),
        title: "Context Search",
        message: message
    });
}

init();
