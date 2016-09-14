'use strict';

var async = require('async');
var debug = require('debug')('kong-adapter:portal');
var utils = require('./utils');

var portal = function () { };

// ======== INTERFACE FUNCTIONS =======

portal.getPortalApis = function (app, done) {
    debug('getPortalApis()');
    utils.apiGet(app, 'apis', function (err, apiList) {
        if (err)
            return done(err);

        async.eachSeries(apiList.apis, function (apiDef, callback) {
            utils.apiGet(app, 'apis/' + apiDef.id + '/config', function (err, apiConfig) {
                if (err)
                    return callback(err);
                apiDef.config = checkApiConfig(app, apiConfig);
                return callback(null);
            });
        }, function (err) {
            if (err)
                return done(err);

            var portalHost = app.kongGlobals.network.portalUrl;
            if (!portalHost) {
                debug('portalUrl is not set in globals.json, defaulting to http://portal:3000');
                portalHost = 'http://portal:3000'; // Default
            }
            // Add the Swagger UI "API" for tunneling
            var swaggerApi = require('../resources/swagger-ui.json');
            swaggerApi.config.api.upstream_url = portalHost + '/swagger-ui';
            apiList.apis.push(swaggerApi);

            // And a Ping end point for monitoring            
            var pingApi = require('../resources/ping-api.json');
            pingApi.config.api.upstream_url = portalHost + '/ping';
            apiList.apis.push(pingApi);

            // Add the /deploy API
            var deployApi = require('../resources/deploy-api.json');
            var apiUrl = app.kongGlobals.network.apiUrl;
            if (!apiUrl) {
                debug('apiUrl is not set in globals.json, defaulting to http://portal-api:3001');
                apiUrl = 'http://portal-api:3001';
            }
            if (apiUrl.endsWith('/'))
                apiUrl = apiUrl.substring(0, apiUrl.length - 1);
            deployApi.config.api.upstream_url = apiUrl + '/deploy';
            apiList.apis.push(deployApi);

            // And the actual Portal API (OAuth 2.0)
            var portalApi = require('../resources/portal-api.json');
            portalApi.config.api.upstream_url = apiUrl;
            apiList.apis.push(portalApi);

            debug('getPortalApis():');
            debug(apiList);

            try {
                apiList = injectAuthPlugins(app, apiList);
            } catch (injectErr) {
                return done(injectErr);
            }

            return done(null, apiList);
        });
    });
};

function checkApiConfig(app, apiConfig) {
    if (apiConfig.plugins) {
        for (var i = 0; i < apiConfig.plugins.length; ++i) {
            var plugin = apiConfig.plugins[i];
            if (!plugin.name)
                continue;

            switch (plugin.name.toLowerCase()) {
                case "request-transformer":
                    checkRequestTransformerPlugin(app, apiConfig, plugin);
                    break;
            }
        }
    }
    return apiConfig;
}

function checkRequestTransformerPlugin(app, apiConfig, plugin) {
    if (plugin.config &&
        plugin.config.add &&
        plugin.config.add.headers) {

        for (var i = 0; i < plugin.config.add.headers.length; ++i) {
            if (plugin.config.add.headers[i] == '%%Forwarded') {
                var prefix = apiConfig.api.request_path;
                var proto = app.kongGlobals.network.schema;
                var rawHost = app.kongGlobals.network.apiHost;
                var host;
                var port;
                if (rawHost.indexOf(':') > 0) {
                    var splitList = rawHost.split(':');
                    host = splitList[0];
                    port = splitList[1];
                } else {
                    host = rawHost;
                    port = (proto == 'https') ? 443 : 80;
                }

                plugin.config.add.headers[i] = 'Forwarded: host=' + host + ';port=' + port + ';proto=' + proto + ';prefix=' + prefix;
            }
        }
    }
}

/*

This is what we want from the portal:

[
    {
        "consumer": {
            "username": "my-app$petstore",
            "custom_id": "3476ghow89e746goihw576iger5how4576"
        },
        "plugins": {
            "key-auth": [
                { "key": "flkdfjlkdjflkdjflkdfldf" }
            ],
            "acls": [
                { "group": "petstore" }
            ],
            "oauth2": [
                { 
                    "name": "My Application",
                    "client_id": "my-app-petstore",
                    "client_secret": "uwortiu4eot8g7he59t87je59thoerizuoh",
                    "redirect_uri": "http://dummy.org"
                }
            ]
        },
        "apiPlugins": [
            {
                "name": "rate-limiting",
                "config": {
                    "hour": 100,
                    "async": true
                }
            }
        ]
    }
]
*/

portal.getPortalConsumers = function (app, done) {
    debug('getPortalConsumers()');
    async.parallel({
        apiPlans: function (callback) {
            utils.apiGet(app, 'plans', callback);
        },
        applicationList: function (callback) {
            utils.apiGet(app, 'applications', callback);
        },
        userList: function (callback) {
            if (app.kongGlobals.api &&
                app.kongGlobals.api.portal &&
                app.kongGlobals.api.portal.enableApi) {
                utils.apiGet(app, 'users', callback);
            } else {
                process.nextTick(function () { callback(null, []); });
            }
        }
    }, function (err, results) {
        if (err)
            return done(err);

        var apiPlans = results.apiPlans;
        var applicationList = results.applicationList;
        var userList = results.userList;

        debug('getPortalConsumers: apiPlans = ' + utils.getText(apiPlans));
        debug('getPortalConsumers: applicationList = ' + utils.getText(applicationList));
        debug('userList = ' + utils.getText(userList));

        async.parallel({
            appsConsumers: function (callback) {
                enrichApplications(app, applicationList, apiPlans, callback);
            },
            userConsumers: function (callback) {
                enrichUsers(app, userList, callback);
            }
        }, function (err, results) {
            if (err)
                done(err);

            var appsConsumers = results.appsConsumers;
            var userConsumers = results.userConsumers;

            var allConsumers = appsConsumers.concat(userConsumers);
            debug('allConsumers = ' + utils.getText(allConsumers));

            done(null, allConsumers);
        });
    });
};

function userHasGroup(userInfo, group) {
    if (userInfo &&
        userInfo.groups) {
        for (var i=0; i<userInfo.groups.length; ++i) {
            if (userInfo.groups[i] == group)
                return true;
        }
        return false;
    } else {
        return false;
    }
}

function enrichUsers(app, userList, done) {
    console.log('enrichUsers()');
    debug('enrichUsers(), userList = ' + utils.getText(userList));
    // We need to use "apiGetAsUser" here in order to retrieve the client
    // credentials. You won't see those for other users in the UI. 
    async.map(userList, function (userInfo, callback) {
        utils.apiGetAsUser(app, 'users/' + userInfo.id, userInfo.id, callback);
    }, function (err, results) {
        if (err) {
            console.error(err);
            return done(err);
        }

        var userConsumers = [];
        for (var i = 0; i < results.length; ++i) {
            // for (var i=0; i<5; ++i) {
            var thisUser = results[i];

            console.log(thisUser);

            // If this user doesn't have a clientId and clientSecret,
            // we can quit immediately.
            if (!(thisUser.clientId && thisUser.clientSecret)) {
                console.log('User ' + thisUser.email + ' does not have client creds.');
                continue;
            }

            // If we're here, glob.api.portal.enableApi must be true
            var requiredGroup = app.kongGlobals.api.portal.requiredGroup; 
            if (requiredGroup &&
                !userHasGroup(thisUser, requiredGroup)) {
                console.log('User ' + thisUser.email + ' does not have correct group.');
                continue;
            }
            var clientId = thisUser.clientId;
            var clientSecret = thisUser.clientSecret;

            var userConsumer = {
                consumer: {
                    username: thisUser.email,
                    custom_id: thisUser.id
                },
                plugins: {
                    acls: [{
                        group: 'portal-api-internal'
                    }],
                    oauth2: [{
                        name: thisUser.email,
                        client_id: clientId,
                        client_secret: clientSecret,
                        redirect_uri: ['http://dummy.org']
                    }]
                },
                apiPlugins: []
            };

            console.log(userConsumer);

            userConsumers.push(userConsumer);
        }

        debug('userConsumers.length == ' + userConsumers.length);

        done(null, userConsumers);
    });
}

function enrichApplications(app, applicationList, apiPlans, done) {
    debug('enrichApplications(), applicationList = ' + utils.getText(applicationList));
    async.map(applicationList, function (appInfo, callback) {
        utils.apiGet(app, 'applications/' + appInfo.id + '/subscriptions', callback);
    }, function (err, results) {
        if (err)
            return done(err);

        var consumerList = [];
        for (var resultIndex = 0; resultIndex < results.length; ++resultIndex) {
            var appSubsInfo = results[resultIndex];
            for (var subsIndex = 0; subsIndex < appSubsInfo.length; ++subsIndex) {
                var appSubs = appSubsInfo[subsIndex];
                // Only propagate approved subscriptions
                if (!appSubs.approved)
                    continue;
                debug(utils.getText(appSubs));
                var consumerInfo = {
                    consumer: {
                        username: appSubs.application + '$' + appSubs.api,
                        custom_id: appSubs.id
                    },
                    plugins: {
                        acls: [{
                            group: appSubs.api
                        }]
                    }
                };
                if ("oauth2" == appSubs.auth) {
                    consumerInfo.plugins.oauth2 = [{
                        name: appSubs.application,
                        client_id: appSubs.clientId,
                        client_secret: appSubs.clientSecret,
                        redirect_uri: ['http://dummy.org']
                    }];
                } else if (!appSubs.auth || "key-auth" == appSubs.auth) {
                    consumerInfo.plugins["key-auth"] = [{
                        key: appSubs.apikey
                    }];
                } else {
                    let err2 = new Error('Unknown auth strategy: ' + appSubs.auth + ', for application "' + appSubs.application + '", API "' + appSubs.api + '".');
                    return done(err2);
                }

                // Now the API level plugins from the Plan
                var apiPlan = getPlanById(apiPlans, appSubs.plan);
                if (!apiPlan) {
                    let err2 = new Error('Unknown API plan strategy: ' + appSubs.plan + ', for application "' + appSubs.application + '", API "' + appSubs.api + '".');
                    return done(err2);
                }

                if (apiPlan.config && apiPlan.config.plugins)
                    consumerInfo.apiPlugins = apiPlan.config.plugins;
                else
                    consumerInfo.apiPlugins = [];

                consumerList.push(consumerInfo);
            }
        }

        debug(utils.getText(consumerList));

        return done(null, consumerList);
    });
}

function getPlanById(apiPlans, planId) {
    debug('getPlanById(' + planId + ')');
    return apiPlans.plans.find(function (plan) { return (plan.id == planId); });
}

// ======== INTERNAL FUNCTIONS =======

function injectAuthPlugins(app, apiList) {
    debug('injectAuthPlugins()');
    for (var i = 0; i < apiList.apis.length; ++i) {
        var thisApi = apiList.apis[i];
        if (!thisApi.auth ||
            "none" == thisApi.auth)
            continue;
        if ("key-auth" == thisApi.auth)
            injectKeyAuth(app, thisApi);
        else if ("oauth2" == thisApi.auth)
            injectClientCredentialsAuth(app, thisApi);
        else
            throw new Error("Unknown 'auth' setting: " + thisApi.auth);
    }
    return apiList;
}

function injectKeyAuth(app, api) {
    debug('injectKeyAuth()');
    if (!api.config.plugins)
        api.config.plugins = [];
    var plugins = api.config.plugins;
    var keyAuthPlugin = plugins.find(function (plugin) { return plugin.name == "key-auth"; });
    if (keyAuthPlugin)
        throw new Error("If you use 'key-auth' in the apis.json, you must not provide a 'key-auth' plugin yourself. Remove it and retry.");
    var aclPlugin = plugins.find(function (plugin) { return plugin.name == 'acl'; });
    if (aclPlugin)
        throw new Error("If you use 'key-auth' in the apis.json, you must not provide a 'acl' plugin yourself. Remove it and retry.");
    plugins.push({
        name: 'key-auth',
        enabled: true,
        config: {
            hide_credentials: true,
            key_names: [app.kongGlobals.api.headerName]
        }
    });
    plugins.push({
        name: 'acl',
        enabled: true,
        config: {
            whitelist: [api.id]
        }
    });
    return api;
}

function injectClientCredentialsAuth(app, api) {
    debug('injectClientCredentialsAuth()');
    if (!api.config.plugins)
        api.config.plugins = [];
    var plugins = api.config.plugins;
    var keyAuthPlugin = plugins.find(function (plugin) { return plugin.name == "key-auth"; });
    if (keyAuthPlugin)
        throw new Error("If you use 'oauth2' in the apis.json, you must not provide a 'oauth2' plugin yourself. Remove it and retry.");
    var aclPlugin = plugins.find(function (plugin) { return plugin.name == 'acl'; });
    if (aclPlugin)
        throw new Error("If you use 'oauth2' in the apis.json, you must not provide a 'acl' plugin yourself. Remove it and retry.");
    plugins.push({
        name: 'oauth2',
        enabled: true,
        config: {
            scopes: ['api'],
            token_expiration: 3600,
            enable_authorization_code: false,
            enable_client_credentials: true,
            enable_implicit_grant: false,
            enable_password_grant: false,
            hide_credentials: true,
            accept_http_if_already_terminated: true
        }
    });
    plugins.push({
        name: 'acl',
        enabled: true,
        config: {
            whitelist: [api.id]
        }
    });
    return api;
}

module.exports = portal;