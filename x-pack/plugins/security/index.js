/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import Boom from 'boom';
import { resolve } from 'path';
import { getUserProvider } from './server/lib/get_user';
import { initAuthenticateApi } from './server/routes/api/v1/authenticate';
import { initUsersApi } from './server/routes/api/v1/users';
import { initPublicRolesApi } from './server/routes/api/public/roles';
import { initPrivilegesApi } from './server/routes/api/public/privileges';
import { initIndicesApi } from './server/routes/api/v1/indices';
import { initLoginView } from './server/routes/views/login';
import { initLogoutView } from './server/routes/views/logout';
import { initLoggedOutView } from './server/routes/views/logged_out';
import { validateConfig } from './server/lib/validate_config';
import { authenticateFactory } from './server/lib/auth_redirect';
import { checkLicense } from './server/lib/check_license';
import { initAuthenticator } from './server/lib/authentication/authenticator';
import { SecurityAuditLogger } from './server/lib/audit_logger';
import { AuditLogger } from '../../server/lib/audit_logger';
import { createAuthorizationService, disableUICapabilitesFactory, registerPrivilegesWithCluster } from './server/lib/authorization';
import { watchStatusAndLicenseToInitialize } from '../../server/lib/watch_status_and_license_to_initialize';
import { SecureSavedObjectsClientWrapper } from './server/lib/saved_objects_client/secure_saved_objects_client_wrapper';
import { deepFreeze } from './server/lib/deep_freeze';
import { createOptionalPlugin } from './server/lib/optional_plugin';

export const security = (kibana) => new kibana.Plugin({
  id: 'security',
  configPrefix: 'xpack.security',
  publicDir: resolve(__dirname, 'public'),
  require: ['kibana', 'elasticsearch', 'xpack_main'],

  config(Joi) {
    return Joi.object({
      authProviders: Joi.array().items(Joi.string()).default(['basic']),
      enabled: Joi.boolean().default(true),
      cookieName: Joi.string().default('sid'),
      encryptionKey: Joi.string(),
      sessionTimeout: Joi.number().allow(null).default(null),
      secureCookies: Joi.boolean().default(false),
      public: Joi.object({
        protocol: Joi.string().valid(['http', 'https']),
        hostname: Joi.string().hostname(),
        port: Joi.number().integer().min(0).max(65535)
      }).default(),
      authorization: Joi.object({
        legacyFallback: Joi.object({
          enabled: Joi.boolean().default(true) // deprecated
        }).default()
      }).default(),
      audit: Joi.object({
        enabled: Joi.boolean().default(false)
      }).default(),
    }).default();
  },

  deprecations: function ({ unused }) {
    return [
      unused('authorization.legacyFallback.enabled'),
    ];
  },

  uiExports: {
    chromeNavControls: ['plugins/security/views/nav_control'],
    managementSections: ['plugins/security/views/management'],
    styleSheetPaths: resolve(__dirname, 'public/index.scss'),
    apps: [{
      id: 'login',
      title: 'Login',
      main: 'plugins/security/views/login',
      hidden: true,
    }, {
      id: 'logout',
      title: 'Logout',
      main: 'plugins/security/views/logout',
      hidden: true
    }, {
      id: 'logged_out',
      title: 'Logged out',
      main: 'plugins/security/views/logged_out',
      hidden: true
    }],
    hacks: [
      'plugins/security/hacks/on_session_timeout',
      'plugins/security/hacks/on_unauthorized_response'
    ],
    home: ['plugins/security/register_feature'],
    injectDefaultVars: function (server) {
      const config = server.config();

      return {
        secureCookies: config.get('xpack.security.secureCookies'),
        sessionTimeout: config.get('xpack.security.sessionTimeout'),
        enableSpaceAwarePrivileges: config.get('xpack.spaces.enabled'),
      };
    },
    replaceInjectedVars: async function (originalInjectedVars, request, server) {
      // if we have a license which doesn't enable security, or we're a legacy user
      // we shouldn't disable any ui capabilities
      const { authorization } = server.plugins.security;
      if (!authorization.mode.useRbac()) {
        return originalInjectedVars;
      }

      const disableUICapabilites = disableUICapabilitesFactory(server, request);
      // if we're an anonymous route, we disable all ui capabilities
      if (request.route.settings.auth === false) {
        return {
          ...originalInjectedVars,
          uiCapabilities: disableUICapabilites.all(originalInjectedVars.uiCapabilities)
        };
      }

      return {
        ...originalInjectedVars,
        uiCapabilities: await disableUICapabilites.usingPrivileges(originalInjectedVars.uiCapabilities)
      };
    }
  },

  async init(server) {
    const plugin = this;

    const config = server.config();
    const xpackMainPlugin = server.plugins.xpack_main;
    const xpackInfo = xpackMainPlugin.info;

    const xpackInfoFeature = xpackInfo.feature(plugin.id);

    // Register a function that is called whenever the xpack info changes,
    // to re-compute the license check results for this plugin
    xpackInfoFeature.registerLicenseCheckResultsGenerator(checkLicense);

    validateConfig(config, message => server.log(['security', 'warning'], message));

    // Create a Hapi auth scheme that should be applied to each request.
    server.auth.scheme('login', () => ({ authenticate: authenticateFactory(server) }));

    server.auth.strategy('session', 'login');

    // The default means that the `session` strategy that is based on `login` schema defined above will be
    // automatically assigned to all routes that don't contain an auth config.
    server.auth.default('session');

    const { savedObjects } = server;

    const spaces = createOptionalPlugin(config, 'xpack.spaces', server.plugins, 'spaces');

    // exposes server.plugins.security.authorization
    const authorization = createAuthorizationService(server, xpackInfoFeature, savedObjects.types, xpackMainPlugin, spaces);
    server.expose('authorization', deepFreeze(authorization));

    watchStatusAndLicenseToInitialize(xpackMainPlugin, plugin, async (license) => {
      if (license.allowRbac) {
        await registerPrivilegesWithCluster(server);
      }
    });

    const auditLogger = new SecurityAuditLogger(server.config(), new AuditLogger(server, 'security'));

    savedObjects.setScopedSavedObjectsClientFactory(({
      request,
    }) => {
      const adminCluster = server.plugins.elasticsearch.getCluster('admin');
      const { callWithRequest, callWithInternalUser } = adminCluster;
      const callCluster = (...args) => callWithRequest(request, ...args);

      if (authorization.mode.useRbac()) {
        const internalRepository = savedObjects.getSavedObjectsRepository(callWithInternalUser);
        return new savedObjects.SavedObjectsClient(internalRepository);
      }

      const callWithRequestRepository = savedObjects.getSavedObjectsRepository(callCluster);
      return new savedObjects.SavedObjectsClient(callWithRequestRepository);
    });

    savedObjects.addScopedSavedObjectsClientWrapperFactory(Number.MIN_VALUE, ({ client, request }) => {
      if (authorization.mode.useRbac()) {
        return new SecureSavedObjectsClientWrapper({
          actions: authorization.actions,
          auditLogger,
          baseClient: client,
          checkPrivilegesDynamicallyWithRequest: authorization.checkPrivilegesDynamicallyWithRequest,
          errors: savedObjects.SavedObjectsClient.errors,
          request,
          savedObjectTypes: savedObjects.types,
        });
      }

      return client;
    });

    getUserProvider(server);

    await initAuthenticator(server);
    initAuthenticateApi(server);
    initUsersApi(server);
    initPublicRolesApi(server);
    initIndicesApi(server);
    initPrivilegesApi(server);
    initLoginView(server, xpackMainPlugin);
    initLogoutView(server);
    initLoggedOutView(server);

    server.injectUiAppVars('login', () => {

      const { showLogin, loginMessage, allowLogin, layout = 'form' } = xpackInfo.feature(plugin.id).getLicenseCheckResults() || {};

      return {
        loginState: {
          showLogin,
          allowLogin,
          loginMessage,
          layout,
        }
      };
    });


    server.ext('onPostAuth', async function (req, h) {
      const path = req.path;

      const { actions, checkPrivilegesDynamicallyWithRequest, mode } = server.plugins.security.authorization;

      // if we don't have a license enabling security, or we're a legacy user, don't validate this request
      if (!mode.useRbac()) {
        return h.continue;
      }

      const checkPrivileges = checkPrivilegesDynamicallyWithRequest(req);

      // Enforce app restrictions
      if (path.startsWith('/app/')) {
        const appId = path.split('/', 3)[2];
        const appAction = actions.app.get(appId);

        const checkPrivilegesResponse = await checkPrivileges(appAction);
        if (!checkPrivilegesResponse.hasAllRequested) {
          return Boom.notFound();
        }
      }

      // Enforce API restrictions for associated applications
      if (path.startsWith('/api/')) {
        const { tags = [] } = req.route.settings;

        const actionTags = tags.filter(tag => tag.startsWith('access:'));

        if (actionTags.length > 0) {
          const feature = path.split('/', 3)[2];
          const apiActions = actionTags.map(tag => actions.api.get(`${feature}/${tag.split(':', 2)[1]}`));

          const checkPrivilegesResponse = await checkPrivileges(apiActions);
          if (!checkPrivilegesResponse.hasAllRequested) {
            return Boom.notFound();
          }
        }
      }

      return h.continue;
    });
  }
});