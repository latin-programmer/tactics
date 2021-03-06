import EventEmitter from 'events';
import clientFactory from 'client/clientFactory.js';

let authClient = clientFactory('auth');
let gameClient = clientFactory('game');

export default class RemoteTransport {
  /*
   * The default constructor is not intended for public use.
   */
  constructor(gameId, gameData) {
    Object.assign(this, {
      playerStatus: new Map(),

      // Ready means the object is hydrated with game data.
      whenReady: new Promise((resolve, reject) => {
        this._resolveReady = resolve;
        this._rejectReady = reject;
      }),

      // Started means the game has started (and possibly ended)
      whenStarted: new Promise(resolve => this._resolveStarted = resolve),

      _data:    null,
      _emitter: new EventEmitter(),
    });

    gameClient
      .on('event', ({ body }) => {
        if (body.group !== `/games/${gameId}`) return;

        this._emit(body);
      })
      .on('open', ({ data }) => {
        // Connection may be lost after listening to events, but before joining
        // the game and getting the data.  In that case, resume is a no-op and
        // the attempt to join will be retried.
        if (!this._data) return;

        if (data.reason === 'resume')
          this._resume();
        else
          this._reset(data.outbox);
      })
      .on('close', () => {
        let myPlayerId = authClient.playerId;
        let playerStatus = [...this.playerStatus].map(([playerId]) => {
          if (playerId === myPlayerId)
            return { playerId, status:'offline' };
          else
            return { playerId, status:'unavailable' };
        });

        this._emit({ type:'playerStatus', data:playerStatus });
      });

    this._watchForDataChanges();

    // For now, joining ended games is ok... unless not authorized.
    if (gameData && gameData.state.ended && !authClient.token) {
      this._data = gameData;
      Object.assign(this._data.state, {
        started:     new Date(gameData.state.started),
        turnStarted: new Date(gameData.state.turnStarted),
        ended:       new Date(gameData.state.ended),
      });
      this._resolveReady();
      this._resolveStarted();
    }
    else
      this._init(gameId);
  }

  /*
   * Public Methods
   */
  on(eventType, fn) {
    this._emitter.addListener(...arguments);

    return this;
  }
  once(eventType, fn) {
    let listener = () => {
      this.off(eventType, listener);
      fn();
    };

    this.on(eventType, listener);
  }
  off() {
    this._emitter.removeListener(...arguments);

    return this;
  }

  /*
   * Game Data Properties
   * These are cached and kept in sync for arbitrary access.
   */
  get type() {
    return this._getStateData('type');
  }
  get teams() {
    return this._getStateData('teams');
  }
  get turnTimeLimit() {
    return this._getStateData('turnTimeLimit');
  }
  get turnStarted() {
    return this._getStateData('turnStarted');
  }
  get currentTurnId() {
    return this._getStateData('currentTurnId');
  }
  get currentTeamId() {
    return this._getStateData('currentTeamId');
  }
  // This property is not natively actually kept in sync.  The server only sends
  // units' data at initialization, start of game, or on revert.  But, the game
  // object will keep it in sync as each turn ends.
  get units() {
    return this._getStateData('units');
  }
  set units(units) {
    this._data.state.units = units;
  }
  get actions() {
    return this._getStateData('actions');
  }
  get winnerId() {
    return this._getStateData('winnerId');
  }

  get created() {
    return this._getData('created');
  }
  get started() {
    return this._getStateData('started');
  }
  get ended() {
    return this._getStateData('ended');
  }

  get undoRequest() {
    return this._getData('undoRequest');
  }

  /*
   * Proxy these methods to the game client.
   * Returns a promise that resolves to the method result, if any.
   */
  getTurnData() {
    return gameClient.getTurnData(this._data.id, ...arguments);
  }
  getTurnActions() {
    return gameClient.getTurnActions(this._data.id, ...arguments);
  }
  undo() {
    return gameClient.undo(this._data.id);
  }
  restart() {
    return gameClient.restart(this._data.id, ...arguments);
  }
  submitAction(action) {
    return gameClient.submitAction(this._data.id, action);
  }
  acceptUndo() {
    gameClient.acceptUndo(this._data.id);
  }
  rejectUndo() {
    gameClient.rejectUndo(this._data.id);
  }
  cancelUndo() {
    gameClient.cancelUndo(this._data.id);
  }

  /*
   * Other Private Methods
   */
  _init(gameId) {
    gameClient.watchGame(gameId).then(({playerStatus, gameData}) => {
      // Event caught internally to set this.playerStatus.
      this._emit({ type:'playerStatus', data:playerStatus });

      if (gameData.undoRequest)
        Object.assign(gameData.undoRequest, {
          createdAt: new Date(gameData.undoRequest.createdAt),
          accepts: new Set(gameData.undoRequest.accepts),
        });

      this._data = gameData;
      Object.assign(this._data.state, {
        started:
          gameData.state.started && new Date(gameData.state.started),
        turnStarted:
          gameData.state.turnStarted && new Date(gameData.state.turnStarted),
      });
      this._data.state.actions.forEach(action => {
        action.created = new Date(action.created);
      });
      this._resolveReady();

      if (gameData.state.started)
        this._resolveStarted();
    }).catch(error => {
      if (error === 'Connection reset')
        return this._init(gameId);

      // The error is assumed to be permanent.
      this._rejectReady(error);
    });
  }
  _resume() {
    // For now, joining ended games is ok.
    //if (this._data.state.ended) return;

    let gameId = this._data.id;

    gameClient.whenAuthorized.then(() => {
      let myPlayerId = authClient.playerId;

      this._emit({
        type: 'playerStatus',
        data: { playerId:myPlayerId, status:'online' },
      });

      gameClient.getPlayerStatus(gameId).then(playerStatus =>
        this._emit({ type:'playerStatus', data:playerStatus })
      );
    });
  }
  _reset(outbox) {
    // For now, joining ended games is ok.
    //if (this._data.state.ended) return;

    let gameId = this._data.id;
    let state = this._data.state;
    let actions = state.actions;
    let resume;

    if (state.ended)
      resume = null;
    else if (state.started)
      resume = {
        turnId: state.currentTurnId,
        actions: actions.length,
        since: actions.length ? actions.last.created : state.turnStarted,
      };
    else
      resume = { since:'start' };

    // Instead of watching the game from its current point, resume watching
    // the game from the point we lost connection.
    gameClient.watchGame(gameId, resume).then(data => {
      this._emit({ type:'playerStatus', data:data.playerStatus });

      if (data.events)
        data.events.forEach(e => this._emit(e));

      if (data.undoRequest)
        // Inform the game of a change in undo status, if any.
        this._emit({ type:'undoRequest', data:data.undoRequest });
      else if (this._data.undoRequest)
        // Not sure if the request was rejected or accepted.
        // But 'complete' will result in hiding the dialog, if any.
        this._emit({ type:'undoComplete' });

      if (!outbox) return;

      // Resend specific lost messages
      outbox.forEach(message => {
        if (message.type !== 'event') return;
        let event = message.body;
        if (event.service !== 'game') return;
        if (event.group !== `/games/${gameId}`) return;

        if (event.type === 'action')
          gameClient.submitAction(gameId, event.data);
      });
    });
  }

  _watchForDataChanges(gameData) {
    this
      .on('playerStatus', ({ data }) => {
        if (!Array.isArray(data))
          data = [data];

        data.forEach(ps => this.playerStatus.set(ps.playerId, ps.status));
      })
      .on('startGame', ({ data }) => {
        Object.assign(this._data.state, {
          started: new Date(data.started),
          teams: data.teams,
          units: data.units,
        });
        this._resolveStarted();
      })
      .on('startTurn', ({ data }) => {
        Object.assign(this._data.state, {
          turnStarted: new Date(data.started),
          currentTurnId: data.turnId,
          currentTeamId: data.teamId,
          actions: [],
        });
      })
      .on('action', ({ data:actions }) => {
        actions.forEach(action => {
          action.created = new Date(action.created);
        });
        this._data.state.actions.push(...actions);

        // Clear the undo request to permit a new request.
        this._data.undoRequest = null;
      })
      .on('undoRequest', ({ data }) => {
        this._data.undoRequest = Object.assign({}, data, {
          createdAt: new Date(data.createdAt),
          accepts: new Set(data.accepts),
        });
      })
      .on('undoAccept', ({ data }) => {
        let undoRequest = this._data.undoRequest;
        let teams = this._data.state.teams;

        teams.forEach(team => {
          if (team.playerId === data.playerId)
            undoRequest.accepts.add(team.id);
        });
      })
      .on('undoReject', ({ data }) => {
        let undoRequest = this._data.undoRequest;

        undoRequest.status = 'rejected';
        undoRequest.rejectedBy = data.playerId;
      })
      .on('undoCancel', () => {
        this._data.undoRequest.status = 'cancelled';
      })
      .on('undoComplete', () => {
        this._data.undoRequest.status = 'completed';
      })
      .on('revert', ({ data }) => {
        Object.assign(this._data.state, {
          turnStarted: new Date(data.started),
          currentTurnId: data.turnId,
          currentTeamId: data.teamId,
          // Clone the actions to avoid modifying event data
          actions: [...data.actions],
          units: data.units,
        });

        this._data.state.actions.forEach(action => {
          action.created = new Date(action.created);
        });
      })
      .on('endGame', ({ data }) => {
        Object.assign(this._data.state, {
          winnerId: data.winnerId,
          ended:    new Date(),
        });
      });
  }

  _getData(name) {
    if (!this._data)
      throw new Error('Not ready');

    return this._clone(this._data[name]);
  }
  _getStateData(name) {
    if (!this._data)
      throw new Error('Not ready');

    return this._clone(this._data.state[name]);
  }

  _clone(value) {
    if (value instanceof Date)
      return value;
    else if (Array.isArray(value))
      return [...value];
    else if (typeof value === 'object' && value !== null)
      return {...value};
    return value;
  }
  _emit(event) {
    this._emitter.emit(event.type, event);
    this._emitter.emit('event', event);
  }
}
