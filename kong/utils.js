'use strict';

var request = require('request');
var debug = require('debug')('kong-adapter:utils');
var crypto = require('crypto');

var utils = function() { };

utils.getUtc = function () {
    return Math.floor((new Date()).getTime() / 1000);
};

utils.createRandomId = function () {
    return crypto.randomBytes(20).toString('hex');
};

utils.getJson = function(ob) {
    if (ob instanceof String || typeof ob === "string") {
        if (ob === "")
            return null;
        return JSON.parse(ob);
    }
    return ob;
};

utils.getText = function(ob) {
    if (ob instanceof String || typeof ob === "string")
        return ob;
    return JSON.stringify(ob, null, 2);
};

utils.getIndexBy = function(anArray, predicate) {
    for (var i=0; i<anArray.length; ++i) {
        if (predicate(anArray[i]))
            return i;
    }
    return -1;
};

// Check for left side inclusion in right side, NOT vice versa
utils.matchObjects = function(apiObject, kongObject) {
    debug('matchObjects()');
    var returnValue = matchObjectsInternal(apiObject, kongObject);
    if (!returnValue) {
        debug(' - objects do not match.');
        debug('apiObject: ' + JSON.stringify(apiObject, null, 2));
        debug('kongObject: ' + JSON.stringify(kongObject, null, 2));
    }
    return returnValue;
};

function matchObjectsInternal(apiObject, kongObject) {
    for (let prop in apiObject) {
        if (!kongObject.hasOwnProperty(prop)) {
            //console.log('Kong object does not have property "' + prop + '".');
            return false;
        }
        if ((typeof apiObject[prop]) != (typeof kongObject[prop]))
            return false;
        if (typeof apiObject[prop] == "object") { // Recurse please
            if (!matchObjectsInternal(apiObject[prop], kongObject[prop]))
                return false;
        } else { // other types
            if (apiObject[prop] != kongObject[prop]) {
                //console.log('Property "' + prop + '" does not match ("' + apiObject[prop] + '" vs "' + kongObject[prop] + '").');
                return false;
            }
        }
    }
    return true;
}

utils.getAsUser = function (app, fullUrl, expectedStatusCode, userId, callback) {
    debug('get(): ' + fullUrl);
    request.get({
        url: fullUrl,
        headers: { 'X-UserId': userId } 
    }, function(err, apiResponse, apiBody) {
        if (err)
            return callback(err);
        if (expectedStatusCode != apiResponse.statusCode) {
            var err2 = new Error('utils.get("' + fullUrl + '") return unexpected status ' + apiResponse.statusCode);
            debug(err2.message);
            debug(apiBody);
            err2.status = apiResponse.statusCode;
            return callback(err2);
        }
        return callback(null, utils.getJson(apiBody));
    });
};

utils.get = function(app, fullUrl, expectedStatusCode, callback) {
    return utils.getAsUser(app, fullUrl, expectedStatusCode, '1', callback);
};

utils.apiGet = function(app, url, callback) {
    debug('apiGet(): ' + url);
    var apiUrl = app.get('api_url');
    utils.get(app, apiUrl + url, 200, callback);
};

utils.apiGetAsUser = function (app, url, userId, callback) {
    debug('apiGetAsUser(): ' + url + ', as ' + userId);
    var apiUrl = app.get('api_url');
    utils.getAsUser(app, apiUrl + url, 200, userId, callback);
};

function apiAction(app, method, url, body, expectedStatusCode, callback) {
    debug('apiAction(): ' + method + ', ' + url);
    var apiUrl = app.get('api_url');
    var methodBody = {
        method: method,
        url: apiUrl + url,
        headers: { 'X-UserId': '1' }
    };
    if (method != 'DELETE') {
        methodBody.json = true;
        methodBody.body = body;
    }
    
    debug(method + ' ' + methodBody.url);
    
    request(methodBody, function(err, apiResponse, apiBody) {
        if (err)
            return callback(err);
        if (expectedStatusCode != apiResponse.statusCode) {
            var err2 = new Error('apiAction ' + method + ' on ' + url + ' did not return the expected status code (got: ' + apiResponse.statusCode + ', expected: ' + expectedStatusCode + ').');
            err2.status = apiResponse.statusCode;
            debug(err2.message);
            return callback(err2);
        }
        return callback(null, utils.getJson(apiBody));
    });
}

utils.apiPut = function(app, url, body, callback) {
    apiAction(app, 'PUT', url, body, 200, callback);
};

utils.apiDelete = function(app, url, callback) {
    apiAction(app, 'DELETE', url, null, 204, callback);
};

utils.kongGet = function(app, url, callback) {
    var kongUrl = app.get('kong_url');
    utils.get(app, kongUrl + url, 200, callback);
};

function kongAction(app, method, url, body, expectedStatusCode, callback) {
    debug('kongAction(), ' + method + ', ' + url);
    var kongUrl = app.get('kong_url');
    var methodBody = {
        method: method,
        url: kongUrl + url
    };
    if (method != 'DELETE') {
        methodBody.json = true;
        methodBody.body = body;
        if (process.env.KONG_CURL)
            console.error('curl -X ' + method + ' -d \'' + JSON.stringify(body) + '\' -H \'Content-Type: application/json\' ' + methodBody.url);
    } else {
        if (process.env.KONG_CURL)
            console.error('curl -X ' + method + ' ' + methodBody.url);
    }
    
    //debug(method + ' ' + methodBody.url);
    
    request(methodBody, function(err, apiResponse, apiBody) {
        if (err)
            return callback(err);
        if (expectedStatusCode != apiResponse.statusCode) {
            var err2 = new Error('kongAction ' + method + ' on ' + url + ' did not return the expected status code (got: ' + apiResponse.statusCode + ', expected: ' + expectedStatusCode + ').');
            err2.status = apiResponse.statusCode;
            debug(apiBody);
            console.error(apiBody);
            return callback(err2);
        }
        callback(null, utils.getJson(apiBody));
    });
}

utils.kongPost = function(app, url, body, callback) {
    debug('kongPost(): ' + url + ', "' + utils.getText(body) + '"');
    kongAction(app, 'POST', url, body, 201, callback);
};

utils.kongDelete = function(app, url, callback) {
    kongAction(app, 'DELETE', url, null, 204, callback);
};

utils.kongPatch = function(app, url, body, callback) {
    debug('kongPatch(): ' + url + ', "' + utils.getText(body) + '"');
    kongAction(app, 'PATCH', url, body, 200, callback);
};

utils.getPlan = function (app, planId, callback) {
    debug('getPlan() - ' + planId);
    utils.getPlans(app, function (err, plans) {
        if (err)
            return callback(err);
        internalGetPlan(plans, planId, callback);
    });
};

utils._plans = null;
utils.getPlans = function (app, callback) {
    debug('getPlans()');
    if (!utils._plans) {
        utils.apiGet(app, 'plans', function (err, results) {
            if (err)
                return callback(err);
            utils._plans = results;
            return callback(null, utils._plans);
        });
    } else {
        return callback(null, utils._plans);
    }
};

function internalGetPlan(plans, planId, callback) {
    const plan = plans.plans.find(p => p.id === planId);
    if (!plan)
        return callback(new Error('Unknown plan ID: ' + planId));
    return callback(null, plan);
}

utils.findWithName = function (someArray, name) {
    for (var i = 0; i < someArray.length; ++i) {
        if (someArray[i].name === name)
            return someArray[i];
    }
    return null;
};

module.exports = utils;