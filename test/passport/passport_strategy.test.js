'use strict';

const http = require('http');
const sinon = require('sinon');
const MockRequest = require('readable-mock-req');
const expect = require('chai').expect;
const Issuer = require('../../lib').Issuer;
const Strategy = require('../../lib').Strategy;

describe('OpenIDConnectStrategy', function () {
  before(function () {
    this.origIncomingMessage = http.IncomingMessage;
    http.IncomingMessage = MockRequest;
  });

  after(function () {
    http.IncomingMessage = this.origIncomingMessage;
  });

  beforeEach(function () {
    this.issuer = new Issuer({
      issuer: 'https://op.example.com',
      authorization_endpoint: 'https://op.example.com/auth',
      jwks_uri: 'https://op.example.com/jwks',
      token_endpoint: 'https://op.example.com/token',
      userinfo_endpoint: 'https://op.example.com/userinfo',
    });

    this.client = new this.issuer.Client({
      client_id: 'foo',
      client_secret: 'barbaz',
      respose_types: ['code'],
      redirect_uris: ['http://rp.example.com/cb'],
    });
  });

  it('checks for session presence', function (next) {
    const strategy = new Strategy(this.client, () => {});

    const req = new MockRequest('GET', '/login/oidc');

    strategy.error = (error) => {
      try {
        expect(error).to.be.an.instanceof(Error);
        expect(error.message).to.match(/session/);
        next();
      } catch (err) {
        next(err);
      }
    };
    strategy.authenticate(req);
  });

  describe('initate', function () {
    it('starts authentication requests for GETs', function () {
      const strategy = new Strategy(this.client, () => {});

      const req = new MockRequest('GET', '/login/oidc');
      req.session = {};

      strategy.redirect = sinon.spy();
      strategy.authenticate(req);

      expect(strategy.redirect.calledOnce).to.be.true;
      const target = strategy.redirect.firstCall.args[0];
      expect(target).to.include('redirect_uri=');
      expect(target).to.include('scope=');
      expect(req.session).to.have.property('oidc:op.example.com');
      expect(req.session['oidc:op.example.com']).to.have.keys('state');
    });

    it('starts authentication requests for POSTs', function () {
      const strategy = new Strategy(this.client, () => {});

      const req = new MockRequest('POST', '/login/oidc');
      req.session = {};
      req.body = {};

      strategy.redirect = sinon.spy();
      strategy.authenticate(req);

      expect(strategy.redirect.calledOnce).to.be.true;
      const target = strategy.redirect.firstCall.args[0];
      expect(target).to.include('redirect_uri=');
      expect(target).to.include('scope=');
      expect(req.session).to.have.property('oidc:op.example.com');
      expect(req.session['oidc:op.example.com']).to.have.keys('state');
    });

    it('can have redirect_uri and scope specified', function () {
      const strategy = new Strategy({
        client: this.client,
        params: {
          redirect_uri: 'https://example.com/cb',
          scope: 'openid profile',
        },
      }, () => {});

      const req = new MockRequest('GET', '/login/oidc');
      req.session = {};

      strategy.redirect = sinon.spy();
      strategy.authenticate(req);

      expect(strategy.redirect.calledOnce).to.be.true;
      const target = strategy.redirect.firstCall.args[0];
      expect(target).to.include(`redirect_uri=${encodeURIComponent('https://example.com/cb')}`);
      expect(target).to.include('scope=openid%20profile');
    });

    it('automatically includes nonce for where it applies', function () {
      const strategy = new Strategy({
        client: this.client,
        params: {
          response_type: 'code id_token token',
          response_mode: 'form_post',
        },
      }, () => {});

      const req = new MockRequest('GET', '/login/oidc');
      req.session = {};

      strategy.redirect = sinon.spy();
      strategy.authenticate(req);

      expect(strategy.redirect.calledOnce).to.be.true;
      const target = strategy.redirect.firstCall.args[0];
      expect(target).to.include('redirect_uri=');
      expect(target).to.include('scope=');
      expect(target).to.include('nonce=');
      expect(target).to.include('response_mode=form_post');
      expect(req.session).to.have.property('oidc:op.example.com');
      expect(req.session['oidc:op.example.com']).to.have.keys('state', 'nonce');
    });
  });

  describe('callback', function () {
    it('triggers the verify function and then the success one', function (next) {
      const ts = { foo: 'bar' };
      sinon.stub(this.client, 'authorizationCallback').callsFake(function () {
        return Promise.resolve(ts);
      });

      const strategy = new Strategy(this.client, (tokenset, done) => {
        expect(tokenset).to.equal(ts);
        done(null, tokenset);
      });

      strategy.success = () => { next(); };

      const req = new MockRequest('GET', '/login/oidc/callback?code=foobar&state=state');
      req.session = {
        'oidc:op.example.com': {
          nonce: 'nonce',
          state: 'state',
        },
      };

      strategy.authenticate(req);
    });

    it('triggers the error function when server_error is encountered', function (next) {
      const strategy = new Strategy(this.client, () => {});

      const req = new MockRequest('GET', '/login/oidc/callback?error=server_error');
      req.session = {};

      strategy.error = (error) => {
        try {
          expect(error.error).to.equal('server_error');
          next();
        } catch (err) {
          next(err);
        }
      };

      strategy.authenticate(req);
    });

    it('triggers the error function when non oidc error is encountered', function (next) {
      const strategy = new Strategy(this.client, () => {});

      sinon.stub(this.client, 'authorizationCallback').callsFake(function () {
        return Promise.reject(new Error('callback error'));
      });

      const req = new MockRequest('GET', '/login/oidc/callback?code=code');
      req.session = {};

      strategy.error = (error) => {
        try {
          expect(error.message).to.equal('callback error');
          next();
        } catch (err) {
          next(err);
        }
      };

      strategy.authenticate(req);
    });

    it('triggers the fail function when oidc error is encountered', function (next) {
      const strategy = new Strategy(this.client, () => {});

      const req = new MockRequest('GET', '/login/oidc/callback?error=login_required&state=state');
      req.session = {
        'oidc:op.example.com': {
          state: 'state',
        },
      };

      strategy.fail = (error) => {
        try {
          expect(error.message).to.equal('login_required');
          next();
        } catch (err) {
          next(err);
        }
      };

      strategy.authenticate(req);
    });

    it('triggers the error function for errors during verify', function (next) {
      const strategy = new Strategy(this.client, (tokenset, done) => {
        done(new Error('user find error'));
      });

      const ts = { foo: 'bar' };
      sinon.stub(this.client, 'authorizationCallback').callsFake(function () {
        return Promise.resolve(ts);
      });

      const req = new MockRequest('GET', '/login/oidc/callback?code=foo&state=state');
      req.session = {
        'oidc:op.example.com': {
          state: 'state',
        },
      };

      strategy.error = (error) => {
        try {
          expect(error.message).to.equal('user find error');
          next();
        } catch (err) {
          next(err);
        }
      };

      strategy.authenticate(req);
    });

    it('triggers the fail function when verify yields no account', function (next) {
      const strategy = new Strategy(this.client, (tokenset, done) => {
        done();
      });

      const ts = { foo: 'bar' };
      sinon.stub(this.client, 'authorizationCallback').callsFake(function () {
        return Promise.resolve(ts);
      });

      const req = new MockRequest('GET', '/login/oidc/callback?code=foo&state=state');
      req.session = {
        'oidc:op.example.com': {
          nonce: 'nonce',
          state: 'state',
        },
      };

      strategy.fail = () => {
        next();
      };

      strategy.authenticate(req);
    });

    it('does userinfo request too if part of verify arity and resulting tokenset', function (next) {
      const strategy = new Strategy(this.client, (tokenset, userinfo, done) => {
        try {
          expect(tokenset).to.be.ok;
          expect(userinfo).to.be.ok;
          done(null, { sub: 'foobar' });
        } catch (err) {
          next(err);
        }
      });

      const ts = { access_token: 'foo' };
      const ui = { sub: 'bar' };
      sinon.stub(this.client, 'authorizationCallback').callsFake(function () {
        return Promise.resolve(ts);
      });
      sinon.stub(this.client, 'userinfo').callsFake(function () {
        return Promise.resolve(ui);
      });

      const req = new MockRequest('GET', '/login/oidc/callback?code=foo&state=state');
      req.session = {
        'oidc:op.example.com': {
          nonce: 'nonce',
          state: 'state',
        },
      };

      strategy.success = () => {
        next();
      };

      strategy.authenticate(req);
    });

    it('skips userinfo request too if no tokenset but arity', function (next) {
      const strategy = new Strategy(this.client, (tokenset, userinfo, done) => {
        try {
          expect(tokenset).to.be.ok;
          expect(userinfo).to.be.undefined;
          done(null, { sub: 'foobar' });
        } catch (err) {
          next(err);
        }
      });

      const ts = { id_token: 'foo' };
      sinon.stub(this.client, 'authorizationCallback').callsFake(function () {
        return Promise.resolve(ts);
      });

      const req = new MockRequest('GET', '/login/oidc/callback?code=foo&state=state');
      req.session = {
        'oidc:op.example.com': {
          nonce: 'nonce',
          state: 'state',
        },
      };

      strategy.success = () => {
        next();
      };

      strategy.authenticate(req);
    });
  });
});
