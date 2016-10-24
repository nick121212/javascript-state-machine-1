import ValueMap from './utils/ValueMap';
import Transition from './Transition';
import { SystemEvent, TransitionEvent } from './Events';
import { isString, isFunction } from './utils/utils';
import { getPath, parse } from './utils/handlers'

export default function StateMachine (scope, config)
{
    // parameters
    if(arguments.length == 1)
    {
        [config, scope] = [scope, null];
    }

    // assignment
    this.scope          = scope;
    this.state          = '';
    this.states         = [];
    this.transitions    = new ValueMap();
    this.actions        = new ValueMap();
    this.handlers       = new ValueMap();

    // initialize
    if(config)
    {
        this.initialize(config);
    }
}

StateMachine.parse = parse;
StateMachine.getPath = getPath;

/**
 * StateMachine prototype
 *
 * The property examples below illustrate a 4-state machine, with states:
 *
 * - intro > settings > summary > end
 *
 * And actions:
 *
 * - back | next | restart | finish
 */
StateMachine.prototype =
{
    // ------------------------------------------------------------------------------------------------
    // properties

        /**
         * Available state names
         *
         * - [
         *     intro,
         *     settings,
         *     summary,
         *     final
         *   ]
         *
         * @var {string[]}
         */
        states      : null,

        /**
         * Available transitions for each action
         *
         * action.from => to
         *
         * - next: {
         *     intro: settings,
         *     settings: summary
         *   },
         * - back: {
         *     settings: intro
         *   },
         * - restart: {
         *     summary:intro
         *   },
         * - finish: {
         *     summary:final
         *   },
         *
         * Transitions can also be functions
         *
         * - next: {
         *     intro: function() { return '<random state>' } // jump to a random state
         *   }
         *
         * @var {ValueMap}
         */
        transitions : null,

        /**
         * Actions that are available to be called from each state
         *
         * state => [ action, action, ... ]
         *
         * - intro: [
         *     'next'
         *   ],
         * - settings: [
         *     'next',
         *     'back'
         *   ],
         * - summary: [
         *     'restart'
         *     'finish',
         *   ]
         *
         * Actions can also be expressed as wildcards
         *
         * - intro: [
         *     '*' // any action is allowed from intro
         *   ]
         *
         * @var {ValueMap}
         */
        actions     : null,

        /**
         * Handler functions that should be called on each action event / state change
         *
         * name.type => [ handler, handler, ... ]
         *
         * - next: {
         *   - start: [
         *       hideModal
         *     ],
         *   - end: [
         *       showModal
         *     ]
         *   },
         * - summary: {
         *   - enter: [
         *       resetForm
         *     ],
         *   - leave: [
         *       validateForm,
         *       postData,
         *     ]
         *   },
         *   ...
         *
         * @var {ValueMap}
         */
        handlers   : null,

        /**
         * The current state
         *
         * @var {string}
         */
        state       : '',

        /**
         * Any active Transition object that is driving the state change
         *
         * @var {Transition}
         */
        transition  : null,

        /**
         * The scope in which to call all handlers
         *
         * @var {*}
         */
        scope      : null,

        /**
         * The original config object
         *
         * @var {Object}
         */
        config      : null,


    // ------------------------------------------------------------------------------------------------
    // private methods

        /**
         * Initialize the FSM with a config object
         *
         * @private
         * @param config
         */
        initialize:function (config)
        {
            // assign config
            this.config     = config;

            // scope
            if(config.scope)
            {
                this.scope = config.scope;
            }

            // pre-collate all states
            addStates(this, 'from', config.events);
            addStates(this, 'to', config.events);

            // initial state
            if( ! config.initial )
            {
                config.initial = this.states[0];
            }

            // add transitions
            config.events.map( event =>
            {
                // shorthand
                if(isString(event))
                {
                    let matches = event.match(/(\w+)\s*[\|:=]\s*(\w+)\s*([<>-])\s*(\w.*)/);
                    let [,name, from, op, to] = matches;
                    if(op === '-')
                    {
                        this.add(name, from, to);
                        this.add(name, to, from);
                        return;
                    }
                    if(op === '<')
                    {
                        [from, to] = [to, from];
                    }
                    this.add(name, from, to);
                }

                // keys
                else
                {
                    this.add(event.name, event.from, event.to);
                }
            });

            // add handlers
            for(let name in config.handlers)
            {
                if(config.handlers.hasOwnProperty(name))
                {
                    this.on(name, config.handlers[name]);
                }
            }

            // start automatically unless defer is set to true
            if( ! config.defer )
            {
                this.state = config.initial;
            }

            /**
             * Sets defaults for various declarations
             *
             * @type {Object}
             */
            config.defaults = Object.assign({

                // initialize event
                initialize  :'initialize',

                // handler defaults
                action      :'start',
                state       :'enter'

            }, config.defaults);

            /**
             * Sets the default order to run transition callbacks in
             *
             * @type {string[]} type.target
             */
            config.order = config.order ||
            [
                'action.*.start',
                'action.{action}.start',
                'state.{*}.{action}',
                'state.{from}.{action}',
                'state.{from}.leave',
                'state.*.leave',
                'state.*.enter',
                'state.{to}.enter',
                //'state.{to}.{action}',
                'action.{action}.end',
                'action.*.end'
            ];
        },

        /**
         * Dispatch an event
         *
         * @param   {string}    namespace
         * @param   {string}    type
         * @param   {string}    key
         * @param   {*}         value
         * @returns {StateMachine}
         */
        update: function (namespace, type, key = '', value = null)
        {
            let signature = namespace + '.' + type;
            let event = namespace === 'system'
                ? new SystemEvent(type, key, value)
                : new TransitionEvent(type);
            this.dispatch(signature, event);
            return this;
        },


    // ------------------------------------------------------------------------------------------------
    // api

        /**
         * Attempt to run an action, resulting in a transition to a state
         *
         * @param   {string}    action
         * @param   {*[]}       rest
         * @returns {boolean}
         */
        do: function (action, ...rest)
        {
            if(this.can(action) && !this.isPaused())
            {
                this.transition = Transition.create(this, action, rest);
                if(action === this.config.defaults.initialize)
                {
                    this.update('system', 'initialize');
                }
                this.update('system', 'update', 'transition', this.transition);
                this.transition.exec();
                return true;
            }
            return false;
        },

        /**
         * Attempt to go to a state
         *
         * Finds if an appropriate transition exists, then calls the related action if it does
         *
         * @param   {string}    state
         * @param   {boolean}   [force]
         * @returns {boolean}
         */
        go: function (state, force = false)
        {
            if(this.has(state))
            {
                if(force)
                {
                    this.transition = Transition.force(this, state);
                    return this.end();
                }
                var action = this.getActionForState(state);
                if(action)
                {
                    return this.do(action);
                }
                this.config.debug && console.info('No transition exists from "%s" to "%s"', this.state, state);
            }
            else
            {
                this.config.debug && console.warn('No such state "%s"', state);
            }
            return false;
        },

        /**
         * Query a transition to see if a named action is available
         *
         * @param   {string}    action
         * @returns {boolean}
         */
        can: function (action)
        {
            if( ! this.actions.has(action) )
            {
                this.config.debug && console.warn('No such action "%s"', action);
            }
            return !! this.transitions.has(this.state, action);
        },

        /**
         * Query a transition to see if a named action is unavailable
         *
         * @param   {string}    action
         * @returns {boolean}
         */
        cannot: function (action)
        {
            return ! this.can(action);
        },

        /**
         * Test if the current state is the same as the supplied one
         *
         * @param   {string}    state       A state name to compare against the current state
         * @returns {boolean}
         */
        is: function (state)
        {
            if(this.states.indexOf(state) === -1)
            {
                this.config.debug && console.warn('No such state "%s"', state);
            }
            return state === this.state;
        },

        /**
         * Test if a state exists
         *
         * @param   {string}    state
         * @return  {boolean}
         */
        has: function(state)
        {
            return this.states.indexOf(state) !== -1;
        },

        /**
         * Get the available "to" states for the current or supplied state
         *
         * @param   {string}    [state]     Optional name of a state to get states for. Defaults to the current state
         * @returns {string[]}              An array of string states
         */
        getStatesFor: function (state = null)
        {
            state       = state || this.state;
            let actions = this.getActionsFor(state, true);
            return Object.keys(actions).map( name => actions[name] );
        },

        /**
         * Get the available actions (or actions and states) for the current or supplied state
         *
         * @param   {string}    [state]     Optional name of a state to get actions for. Defaults to the current state
         * @param   {boolean}   [asMap]     Optional boolean to return a Object of action:state properties. Defaults to false
         * @returns {string[]|Object}       An array of string actions, or a hash of action:states
         */
        getActionsFor: function (state = '', asMap = false)
        {
            state       = state || this.state;
            let actions = this.transitions.get(state || this.state);
            if(asMap)
            {
                let states  = {};
                actions.map( action =>
                {
                    states[action] = this.actions.get(action + '.' + state);
                });
                return states;
            }
            else
            {
                return actions;
            }
        },

        getActionForState: function (state)
        {
            if(this.has(state))
            {
                let actions = this.getActionsFor(state, true);
                for(let action in actions)
                {
                    if(actions[action] === state)
                    {
                        return action;
                    }
                }
            }
            return null;
        },


    // ------------------------------------------------------------------------------------------------
    // flags

        /**
         * Test if the FSM has started
         *
         * @returns {boolean}
         */
        isStarted: function ()
        {
            return this.state !== '';
        },

        /**
         * Test if the FSM is transitioning
         *
         * @returns {boolean}
         */
        isTransitioning: function ()
        {
            return !! this.transition;
        },

        /**
         * Test if the FSM is paused (whilst transitioning)
         *
         * @returns {boolean}
         */
        isPaused: function ()
        {
            return this.transition
                ? this.transition.paused
                : false;
        },

        /**
         * Test if the FSM is on the "final" state
         *
         * @returns {boolean}
         */
        isComplete: function ()
        {
            return this.state === this.config.final;
        },


    // ------------------------------------------------------------------------------------------------
    // transitions

        /**
         * Pause any current transition
         *
         * @returns {StateMachine}
         */
        pause: function ()
        {
            if(this.transition && !this.isPaused())
            {
                this.transition.pause();
                this.update('transition', 'pause');
                this.update('system', 'update', 'pause', true);
            }
            return this;
        },

        /**
         * Resume any current transition
         *
         * @returns {StateMachine}
         */
        resume: function ()
        {
            if(this.transition && this.isPaused())
            {
                this.update('transition', 'resume');
                this.update('system', 'update', 'pause', false);
                this.transition.resume();
            }
            return this;
        },

        /**
         * Cancel any current transition
         *
         * @returns {StateMachine}
         */
        cancel: function ()
        {
            if(this.transition)
            {
                if(this.isPaused())
                {
                    this.update('system', 'update', 'pause', false);
                }
                this.state = this.transition.from;
                this.transition.clear();
                delete this.transition;
                this.update('transition', 'cancel');
                this.update('system', 'update', 'transition', null);
            }
            return this;
        },

        /**
         * End any current transition, skipping remaining handlers
         *
         * @returns {StateMachine}
         */
        end: function ()
        {
            if(this.transition)
            {
                if(this.isPaused())
                {
                    this.update('system', 'update', 'pause', false);
                }
                this.state = this.transition.to;
                this.transition.clear();
                delete this.transition;
                this.update('system', 'change', 'state', this.state);
                this.update('system', 'update', 'state', this.state);
                if(this.isComplete())
                {
                    this.update('system', 'complete');
                }
                this.update('system', 'update', 'transition', null);
            }
            return this;
        },

        /**
         * Reset the FSM to the initial, or supplied, state
         *
         * @returns {StateMachine}
         */
        reset:function(initial = '')
        {
            let state = initial || this.config.initial;
            this.update('system', 'reset');
            if(this.transition)
            {
                if(this.isPaused())
                {
                    this.update('system', 'update', 'pause', false);
                }
                this.transition.clear();
                delete this.transition;
                this.update('transition', 'cancel');
                this.update('system', 'update', 'transition', null);
            }
            if(this.state !== state)
            {
                this.state = state;
                this.update('system', 'change', 'state', this.state);
                this.update('system', 'update', 'state', this.state);
            }
            return this;
        },


    // ------------------------------------------------------------------------------------------------
    // actions

        /**
         * Add a transition
         *
         * @param   {string}    action
         * @param   {string}    from
         * @param   {string}    to
         * @return  {StateMachine}
         */
        add: function (action, from, to)
        {
            this.actions.set(action + '.' + from, to);
            this.transitions.add(from, action);
            return this;
        },

        /**
         * Remove a transition
         *
         * @param   {string}    action
         * @param   {string}    from
         * @param   {string}    to
         * @return  {StateMachine}
         */
        remove: function (action, from, to)
        {
            this.states.remove(action, from);
            return this;
        },


    // ------------------------------------------------------------------------------------------------
    // handlers

        /**
         * Add an event handler
         *
         * Event handler signatures are build from the following grammar:
         *
         * - token      foo
         * - property   .foo
         * - event      :foo
         * - action     @foo
         * - targets    (foo|bar|baz)
         *
         * For example:
         *
         * - change
         * - transition.pause
         * - next:end
         * - (a|b)@next
         * - a@next
         *
         * The main event types are unique, so can be used without the namespace:
         *
         * - change
         * - pause
         * - complete
         * - ...
         *
         * If your states and events are unique, they can also be used without qualification.
         *
         * See docs and demo for more information
         *
         * @param   {string}        id
         * @param   {Function}      fn
         * @return  {StateMachine}
         */
        on: function (id, fn)
        {
            /** @type {ParseResult} */
            let result = parse(this, id);

            if(this.config.debug)
            {
                console.log('StateMachine on: ' + id, [result.namespace, result.type], result.paths)
            }

            result.paths.map( (path, index) =>
            {
                let target = result.targets[index];

                // warn for invalid actions / states
                if(target !== '*')
                {
                    if(result.namespace === 'state')
                    {
                        if(this.states.indexOf(target) === -1)
                        {
                            this.config.debug && console.warn('StateMachine: Warning assigning state.%s handler; no such state "%s"', result.type, target);
                        }
                    }
                    else if(result.namespace === 'action')
                    {
                        if(!this.actions.has(target))
                        {
                            this.config.debug && console.warn('StateMachine: Warning assigning action.%s handler; no such action "%s"', result.type, target);
                        }
                    }
                }

                // check handler is a function
                if(!isFunction(fn))
                {
                    throw new Error('Error assigning ' +result.namespace+ '.' +result.type+ ' handler; callback is not a Function', fn);
                }

                // assign
                this.handlers.insert(path, fn);
            });

            return this;
        },

        off: function (id, fn)
        {
            let result = parse(this, id);
            result.paths.map( path =>
            {
                this.handlers.remove(path, fn)
            });
        },

        dispatch: function(path, event)
        {
            this.config.debug && console.info('StateMachine: dispatch "%s"', path);
            let handlers = this.handlers.get(path);
            if(handlers)
            {
                // do we need to pass additional arguments?
                handlers.map(fn => fn(event) );
            }
        }

};

/**
 * Parses config and adds unique state names to states array
 *
 * @param {StateMachine}    fsm
 * @param {string}          key
 * @param {Object[]}        transitions
 */
function addStates(fsm, key, transitions)
{
    transitions.map( event => addState(fsm, event[key]) );
}

function addState (fsm, state)
{
    if (isString(state) && fsm.states.indexOf(state) === -1)
    {
        fsm.states.push(state);
    }
}
