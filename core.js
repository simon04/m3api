/* eslint no-unused-vars: [ "error", { "args": "none" } ] */
// Session has abstract methods with parameters only used in subclasses

/**
 * Default options for requests across all sessions.
 *
 * Packages extending m3api’s capabilities (“extension packages”)
 * may add their own options here,
 * conventionally prefixed with the package name and a slash.
 * For example, a package named 'abc' may add options 'abc/x' and 'abc/y',
 * while a package named '@abc/def' may add '@abc/def/x' and '@abc/def/y'.
 * Extension packages are encouraged to use a single options object
 * for their own options as well as ones that are passed through to m3api,
 * rather than e.g. separate options or individual parameters;
 * both kinds of options can then have per-session and global defaults.
 *
 * Changing or removing any default options here is strongly discouraged,
 * and may result in unpredictable behavior.
 */
const DEFAULT_OPTIONS = {
	method: 'GET',
	tokenType: null,
	tokenName: 'token',
	maxRetriesSeconds: 65,
	retryAfterMaxlagSeconds: 5,
	retryAfterReadonlySeconds: 30,
	warn: console.warn,
	dropTruncatedResultWarning: false,
};

const DEFAULT_USER_AGENT = 'm3api/0.6.1 (https://www.npmjs.com/package/m3api)';

const TRUNCATED_RESULT = /^This result was truncated because it would otherwise  ?be larger than the limit of .* bytes$/;

const TOKEN_PLACEHOLDER = Symbol( 'm3api/token-placeholder' );

/**
 * @private
 * @param {Object} params
 * @return {Array.<Object>} [urlParams, bodyParams]
 */
function splitPostParameters( params ) {
	const urlParams = {};
	const bodyParams = {};
	for ( const [ key, value ] of Object.entries( params ) ) {
		if ( key === 'action' || key === 'origin' ) {
			urlParams[ key ] = value;
		} else {
			bodyParams[ key ] = value;
		}
	}
	return [ urlParams, bodyParams ];
}

/**
 * @private
 * Return whether the given warning is *not* a truncatedresult warning.
 *
 * @param {Object} warning
 * @return {boolean}
 */
function notTruncatedResultWarning( warning ) {
	return warning.code ?
		warning.code !== 'truncatedresult' :
		!TRUNCATED_RESULT.test( warning.warnings || warning[ '*' ] );
}

/**
 * @private
 * Return the errors of a response (if any).
 *
 * @param {Object} response
 * @return {Array.<Object>}
 */
function responseErrors( response ) {
	if ( 'error' in response ) {
		return [ response.error ];
	}
	if ( 'errors' in response ) {
		return response.errors;
	}
	return [];
}

/**
 * @private
 * Return the warnings of a response (if any).
 *
 * @param {Object} response
 * @return {Array.<Object>}
 */
function responseWarnings( response ) {
	let warnings = response.warnings;
	if ( !warnings ) {
		return [];
	}

	if ( !Array.isArray( warnings ) ) {
		const bcWarnings = Object.entries( warnings );
		if ( bcWarnings[ 0 ][ 0 ] === 'main' ) {
			// move to end of list
			bcWarnings.push( bcWarnings.shift() );
		}
		warnings = [];
		for ( const [ module, warning ] of bcWarnings ) {
			warning.module = module;
			warnings.push( warning );
		}
	}
	return warnings;
}

/**
 * An Error wrapping one or more API errors.
 */
class ApiErrors extends Error {

	/**
	 * @param {Object[]} errors The error objects from the API.
	 * Must be nonempty, and each error must contain at least a code.
	 * Other error members depend on the errorformat of the request.
	 * @param {...*} params Any other params for the Error constructor.
	 * (Not including the message: the first error code is used for that.)
	 */
	constructor( errors, ...params ) {
		super( errors[ 0 ].code, ...params );

		if ( Error.captureStackTrace ) {
			Error.captureStackTrace( this, ApiErrors );
		}

		this.name = 'ApiErrors';

		/**
		 * The error objects from the API.
		 *
		 * @member {Object[]}
		 */
		this.errors = errors;
	}

}

/**
 * An Error wrapping one or more API warnings.
 */
class ApiWarnings extends Error {

	/**
	 * @param {Object[]} warnings The warning objects from the API.
	 * Must be nonempty; the warning members depend on the errorformat of the request.
	 * @param {...*} params Any other params for the Error constructor.
	 * (Not including the message: the first warning is used for that.)
	 */
	constructor( warnings, ...params ) {
		super(
			warnings[ 0 ].code || warnings[ 0 ].warnings || warnings[ 0 ][ '*' ],
			...params,
		);

		if ( Error.captureStackTrace ) {
			Error.captureStackTrace( this, ApiWarnings );
		}

		this.name = 'ApiWarnings';

		/**
		 * The warning objects from the API.
		 *
		 * @member {Object[]}
		 */
		this.warnings = warnings;
	}

}

/**
 * Decorate the given warn handler so that warnings about truncated results are dropped.
 *
 * Most of the time, you should use the dropTruncatedResultWarning request option
 * instead of using this function directly.
 *
 * @param {Function} warn The original warn function.
 * @return {Function} A new function that, when called,
 * will call the original warn functions,
 * but with all truncated result warnings dropped;
 * when there are no other warnings, the original function is not called.
 */
function makeWarnDroppingTruncatedResultWarning( warn ) {
	return function ( error ) {
		if ( error instanceof ApiWarnings ) {
			const warnings = error.warnings.filter( notTruncatedResultWarning );
			if ( warnings.length > 0 ) {
				return warn( warnings.length === error.warnings.length ?
					error :
					new ApiWarnings( warnings ) );
			}
		} else {
			return warn( error );
		}
	};
}

/**
 * An Error used as a warning when a request with no custom user agent is made.
 */
class DefaultUserAgentWarning extends Error {

	/**
	 * @param {...*} params Any additional params for the Error constructor,
	 * not including the message (which is hard-coded).
	 */
	constructor( ...params ) {
		super(
			'm3api: Sending request with default User-Agent. ' +
				'You should set the userAgent request option, ' +
				'either as a default option for the session (third constructor argument) ' +
				'or as a custom option for each request (second request argument). ' +
				'See w.wiki/4PLr for the User-Agent policy.',
			...params,
		);

		if ( Error.captureStackTrace ) {
			Error.captureStackTrace( this, ApiWarnings );
		}

		this.name = 'DefaultUserAgentWarning';
	}

}

/**
 * A session to make API requests.
 */
class Session {

	/**
	 * @param {string} apiUrl The URL to the api.php endpoint,
	 * such as {@link https://en.wikipedia.org/w/api.php}.
	 * Can also be just the domain, such as en.wikipedia.org.
	 * @param {Object} [defaultParams] Parameters to include in every API request.
	 * See {@link #request} for supported value types.
	 * You are strongly encouraged to specify formatversion: 2 here;
	 * other useful global parameters include uselang, errorformat, maxlag.
	 * @param {Object} [defaultOptions] Options to set for each request.
	 * See {@link #request} for supported options.
	 * You are strongly encouraged to specify a userAgent according to the
	 * {@link https://meta.wikimedia.org/wiki/User-Agent_policy User-Agent policy}.
	 */
	constructor( apiUrl, defaultParams = {}, defaultOptions = {} ) {
		/** @private */
		this.apiUrl = apiUrl;

		/**
		 * Parameters to include in every API request.
		 * Can be modified after construction,
		 * e.g. to add assert=user after logging in.
		 *
		 * @member {Object}
		 */
		this.defaultParams = defaultParams;

		/**
		 * Options to set for each request.
		 * Can be modified after construction.
		 *
		 * @member {Object}
		 */
		this.defaultOptions = defaultOptions;

		/**
		 * Saved/cached tokens.
		 * Can be modified after construction,
		 * particularly to call `clear()` after logging in or out;
		 * apart from that, however,
		 * using the tokenType/tokenName options or {@link #getToken}
		 * is generally more convenient.
		 *
		 * @member {Map}
		 */
		this.tokens = new Map();

		if ( !this.apiUrl.includes( '/' ) ) {
			this.apiUrl = `https://${this.apiUrl}/w/api.php`;
		}
	}

	/**
	 * Make an API request.
	 *
	 * @param {Object} params The parameters.
	 * Values may be strings, numbers, arrays or sets thereof, booleans, null, or undefined.
	 * Parameters with values false, null, or undefined are completely removed.
	 * Default parameters from the constructor are added to these,
	 * with per-request parameters overriding default parameters in case of collision.
	 * @param {Object} [options] Other options for the request.
	 * Default options from the constructor are added to these,
	 * with per-request options overriding default options in case of collision.
	 * @param {string} [options.method] The method, either GET (default) or POST.
	 * @param {string|null} [options.tokenType] Include a token parameter of this type,
	 * automatically getting it from the API if necessary.
	 * The most common token type is 'csrf' (some actions use a different type);
	 * you will also want to set the method option to POST.
	 * @param {string} [options.tokenName] The name of the token parameter.
	 * Only used if the tokenType option is not null.
	 * Defaults to 'token', but some modules need a different name
	 * (e.g. action=login needs 'lgtoken').
	 * @param {string} [options.userAgent] The User-Agent header to send.
	 * (Usually specified as a default option in the constructor.)
	 * @param {number} [options.maxRetriesSeconds] The maximum duration for automatic retries,
	 * i.e. a time interval (in seconds) during which the request will be automatically repeated
	 * according to the Retry-After response header if it is present.
	 * Defaults to 65 seconds; set to 0 to disable automatic retries.
	 * (Can also be a fractional number for sub-second precision.)
	 * @param {number} [options.retryAfterMaxlagSeconds] Default Retry-After header value
	 * in case of a maxlag error. Only used when the response is missing the header.
	 * Since MediaWiki usually sends this header for maxlag errors, this option is rarely used.
	 * Defaults to five seconds, which is the recommended maxlag value for bots.
	 * @param {number} [options.retryAfterReadonlySeconds] Default Retry-After header value
	 * in case of a readonly error. Only used when the response is missing the header.
	 * MediaWiki does not usually send this header for readonly errors,
	 * so this option is more important than the retryAfterMaxlagSeconds option.
	 * The default of 30 seconds is thought to be appropriate for Wikimedia wikis;
	 * for third-party wikis, higher values may be useful
	 * (remember to also increase the maxRetriesSeconds option accordingly).
	 * @param {Function} [options.warn] A handler for warnings from this API request.
	 * Called with a single instance of a subclass of Error, such as {@link ApiWarnings}.
	 * The default is console.warn (interactive CLI applications may wish to change this).
	 * @param {boolean} [options.dropTruncatedResultWarning]
	 * Whether to drop warnings about truncated results instead of passing them to the warn handler.
	 * Occasionally, an API result may not fit into a single network response;
	 * in such cases, the API will add a warning about the result being truncated,
	 * as well as continuation parameters that will result in the remaining information
	 * being included in the next request, if continuation is followed.
	 * If you follow continuation and are prepared to merge truncated responses back together,
	 * you don’t need to see this warning and can use this option to suppress it.
	 * This option defaults to false here (i.e. treat the warning like any other),
	 * but in {@link requestAndContinueReducingBatch} it defaults to true.
	 * @return {Object}
	 * @throws {ApiErrors}
	 */
	async request( params, options = {} ) {
		const {
			method,
			tokenType,
			tokenName,
			maxRetries, // only for warning
			maxRetriesSeconds,
			retryAfterMaxlagSeconds,
			retryAfterReadonlySeconds,
			userAgent,
			warn,
			dropTruncatedResultWarning,
		} = {
			...DEFAULT_OPTIONS,
			...this.defaultOptions,
			...options,
		};
		if ( maxRetries !== undefined && !( 'maxRetriesSeconds' in { ...this.defaultOptions, ...options } ) ) {
			warn( new Error( 'The maxRetries option is no longer supported, ' +
				'use maxRetriesSeconds instead.' ) );
		}
		let fullUserAgent;
		if ( userAgent ) {
			fullUserAgent = `${userAgent} ${DEFAULT_USER_AGENT}`;
		} else {
			if ( !this.warnedDefaultUserAgent ) {
				warn( new DefaultUserAgentWarning() );
				this.warnedDefaultUserAgent = true;
			}
			fullUserAgent = DEFAULT_USER_AGENT;
		}
		const actualWarn = dropTruncatedResultWarning ?
			makeWarnDroppingTruncatedResultWarning( warn ) :
			warn;
		const retryUntil = performance.now() + maxRetriesSeconds * 1000;

		const tokenParams = {};
		if ( tokenType !== null ) {
			tokenParams[ tokenName ] = TOKEN_PLACEHOLDER; // replaced in internalRequest()
		}

		const response = await this.internalRequest(
			method,
			this.transformParams( {
				...this.defaultParams,
				...tokenParams,
				...params,
				format: 'json',
			} ),
			fullUserAgent,
			actualWarn,
			tokenType,
			tokenName,
			retryUntil,
			retryAfterMaxlagSeconds,
			retryAfterReadonlySeconds,
		);

		return response;
	}

	/**
	 * Make a series of API requests, following API continuation.
	 *
	 * @param {Object} params Same as for request.
	 * Continuation parameters will be added automatically.
	 * @param {Object} [options] Same as for request.
	 * @yield {Object}
	 * @throws {ApiErrors}
	 */
	async * requestAndContinue( params, options = {} ) {
		let continueParams = { continue: undefined };
		do {
			const response = await this.request( {
				...params,
				...continueParams,
			}, options );
			continueParams = response.continue && { ...response.continue };
			yield response;
		} while ( continueParams !== undefined );
	}

	/**
	 * Make a series of API requests, following API continuation,
	 * accumulating responses and yielding one result per batch.
	 *
	 * This works conceptually similar to Array.reduce(), but repeatedly,
	 * with each batch of responses corresponding to one array.
	 * At the beginning of each batch, an initial value is generated,
	 * and then for each response in the batch,
	 * a reducer is called with the current value and that response.
	 * (The current value starts out as the initial value;
	 * afterwards, it’s the reducer’s return value for the previous response.)
	 * At the end of each batch, the current value is yielded,
	 * and the process starts over with a new initial value.
	 *
	 * The reducer will typically extract some kind of pages or other entries from the response,
	 * add them to the current value, possibly merging them with existing entries there,
	 * and then return the updated value.
	 * The initial callback defaults to producing empty objects,
	 * but other values are also possible: sets or maps may be useful.
	 *
	 * @param {Object} params Same as for request.
	 * @param {Object} options Same as for request. (But not optional here!)
	 * The dropTruncatedResultWarning option defaults to true here,
	 * since continuation will produce the rest of the truncated result automatically.
	 * @param {Function} reducer A callback like for Array.reduce().
	 * Called with two arguments, the current value and the current response.
	 * @param {Function} [initial] A callback producing initial values.
	 * Called with no arguments. Defaults to producing empty objects.
	 * @yield {*} The last reducer return value for each batch.
	 * Typically, the initial and reducer callbacks will have the same return type,
	 * which will then also be the return type of this function, such as Object, Map, or Set.
	 */
	async * requestAndContinueReducingBatch( params, options, reducer, initial = () => ( {} ) ) {
		options = {
			dropTruncatedResultWarning: true,
			...options,
		};

		let accumulator = initial();
		for await ( const response of this.requestAndContinue( params, options ) ) {
			const complete = responseBoolean( response.batchcomplete );
			accumulator = reducer( accumulator, response );
			if ( complete ) {
				yield accumulator;
				accumulator = initial();
			}
		}
	}

	/**
	 * Get a token of the specified type.
	 *
	 * Though this method is public, it should generally not be used directly:
	 * call {@link #request} with the tokenType/tokenName options instead.
	 *
	 * @param {string} type
	 * @param {Object} options Options for the request to get the token.
	 * @return {string}
	 */
	async getToken( type, options ) {
		if ( !this.tokens.has( type ) ) {
			const params = {
				action: 'query',
				meta: set( 'tokens' ),
				type: set( type ),
			};
			options = {
				...options,
				method: 'GET',
				tokenType: null,
				dropTruncatedResultWarning: true,
			};
			for await ( const response of this.requestAndContinue( params, options ) ) {
				try {
					const token = response.query.tokens[ type + 'token' ];
					if ( typeof token === 'string' ) {
						this.tokens.set( type, token );
						break;
					}
					// if token not found in this response, follow continuation
				} catch ( _ ) {
				}
			}
		}
		return this.tokens.get( type );
	}

	/**
	 * @private
	 * @param {Object} params
	 * @return {Object}
	 */
	transformParams( params ) {
		const transformedParams = {};
		for ( const [ key, value ] of Object.entries( params ) ) {
			const transformedParamValue = this.transformParamValue( value );
			if ( transformedParamValue !== undefined ) {
				transformedParams[ key ] = transformedParamValue;
			}
		}
		return transformedParams;
	}

	/**
	 * @private
	 * @param {*} value
	 * @return {string|undefined}
	 */
	transformParamValue( value ) {
		if ( value instanceof Set ) {
			value = [ ...value ];
		}
		if ( Array.isArray( value ) ) {
			return this.transformParamArray( value );
		} else {
			return this.transformParamScalar( value );
		}
	}

	/**
	 * @private
	 * @param {(string|number)[]} value
	 * @return {string}
	 */
	transformParamArray( value ) {
		if ( value.some( ( element ) => String.prototype.includes.call( element, '|' ) ) ) {
			return '\x1f' + value.join( '\x1f' );
		} else {
			return value.join( '|' );
		}
	}

	/**
	 * @private
	 * @param {*} value
	 * @return {*} string|undefined for string|number|boolean|null|undefined value,
	 * the value unmodified otherwise
	 */
	transformParamScalar( value ) {
		if ( typeof value === 'number' ) {
			return String( value );
		}
		if ( value === true ) {
			return '';
		}
		if ( value === false || value === null || value === undefined ) {
			return undefined;
		}
		return value;
	}

	/**
	 * @private
	 * @param {string} method
	 * @param {Object} params
	 * @param {string} userAgent
	 * @param {Function} warn
	 * @param {string} tokenType
	 * @param {string} tokenName
	 * @param {number} retryUntil (performance.now() clock)
	 * @param {number} retryAfterMaxlagSeconds
	 * @param {number} retryAfterReadonlySeconds
	 * @return {Object}
	 */
	async internalRequest(
		method,
		params,
		userAgent,
		warn,
		tokenType,
		tokenName,
		retryUntil,
		retryAfterMaxlagSeconds,
		retryAfterReadonlySeconds,
	) {
		let tokenParams = null;
		if ( params[ tokenName ] === TOKEN_PLACEHOLDER ) {
			tokenParams = { [ tokenName ]: await this.getToken( tokenType, {
				maxRetriesSeconds: ( retryUntil - performance.now() ) / 1000,
				retryAfterMaxlagSeconds,
				retryAfterReadonlySeconds,
				userAgent,
				warn,
			} ) };
		}

		let result;
		if ( method === 'GET' ) {
			result = this.internalGet( { ...params, ...tokenParams }, userAgent );
		} else if ( method === 'POST' ) {
			const [ urlParams, bodyParams ] = splitPostParameters( { ...params, ...tokenParams } );
			result = this.internalPost( urlParams, bodyParams, userAgent );
		} else {
			throw new Error( `Unknown request method: ${method}` );
		}
		const {
			status,
			headers,
			body,
		} = await result;

		if ( status !== 200 ) {
			throw new Error( `API request returned non-200 HTTP status code: ${status}` );
		}

		const retryIfBefore = ( retryAfterSeconds ) => {
			const retryAfterMillis = 1000 * retryAfterSeconds;
			if ( performance.now() + retryAfterMillis <= retryUntil ) {
				return new Promise( ( resolve ) => {
					setTimeout( resolve, retryAfterMillis );
				} ).then( () => this.internalRequest(
					method,
					params,
					userAgent,
					warn,
					tokenType,
					tokenName,
					retryUntil,
					retryAfterMaxlagSeconds,
					retryAfterReadonlySeconds,
				) );
			} else {
				return null;
			}
		};
		let retryPromise = null;

		const hasRetryAfterHeader = 'retry-after' in headers;
		if ( hasRetryAfterHeader ) {
			retryPromise = retryIfBefore( parseInt( headers[ 'retry-after' ] ) );
			if ( retryPromise !== null ) {
				return retryPromise;
			}
		}

		const errors = responseErrors( body );

		if ( !hasRetryAfterHeader && errors.some( ( { code } ) => code === 'maxlag' ) ) {
			retryPromise = retryIfBefore( retryAfterMaxlagSeconds );
			if ( retryPromise !== null ) {
				return retryPromise;
			}
		}

		if ( !hasRetryAfterHeader && errors.some( ( { code } ) => code === 'readonly' ) ) {
			retryPromise = retryIfBefore( retryAfterReadonlySeconds );
			if ( retryPromise !== null ) {
				return retryPromise;
			}
		}

		if ( tokenParams !== null && errors.some( ( { code } ) => code === 'badtoken' ) ) {
			this.tokens.clear();
			retryPromise = retryIfBefore( 0 /* no delay */ );
			if ( retryPromise !== null ) {
				return retryPromise;
			}
		}

		if ( errors.length > 0 ) {
			throw new ApiErrors( errors );
		}

		const warnings = responseWarnings( body );
		if ( warnings.length > 0 ) {
			warn( new ApiWarnings( warnings ) );
		}

		return body;
	}

	/**
	 * Actually make a GET request.
	 *
	 * @abstract
	 * @protected
	 * @param {Object} params
	 * @param {string} userAgent
	 * @return {Promise<Object>} Object with members status (number),
	 * headers (object mapping lowercase names to string values, without set-cookie),
	 * and body (JSON-decoded).
	 */
	internalGet( params, userAgent ) {
		throw new Error( 'Abstract method internalGet not implemented!' );
	}

	/**
	 * Actually make a POST request.
	 *
	 * @abstract
	 * @protected
	 * @param {Object} urlParams
	 * @param {Object} bodyParams
	 * @param {string} userAgent
	 * @return {Promise<Object>} Same as for internalGet.
	 */
	internalPost( urlParams, bodyParams, userAgent ) {
		throw new Error( 'Abstract method internalPost not implemented!' );
	}

}

/**
 * Convenience function to get a boolean from an API response value.
 *
 * Works for formatversion=1 booleans
 * (absent means false, empty string means true)
 * as well as formatversion=2 booleans
 * (absent or false means false, true means true).
 * Mostly useful in library code,
 * when you don’t know the formatversion of the response.
 * (If you control the request parameters, just use formatversion=2.)
 *
 * @param {boolean|''|undefined} value A value from an API response
 * (e.g. response.query.general.rtl).
 * @return {boolean}
 */
function responseBoolean( value ) {
	return ( value && '' ) === '';
}

/**
 * Convenience function to create a Set.
 *
 * The two invocations
 *
 *     new Set( [ 'a', 'b' ] )
 *     set( 'a', 'b' )
 *
 * are equivalent, but the second one is shorter and easier to type.
 *
 * @param {...*} elements
 * @return {Set}
 */
function set( ...elements ) {
	return new Set( elements );
}

// note: exports that are useful to end-users / applications
// should be re-exported from browser.js and node.js
export {
	DEFAULT_OPTIONS,
	ApiErrors,
	ApiWarnings,
	DefaultUserAgentWarning,
	Session,
	makeWarnDroppingTruncatedResultWarning,
	responseBoolean,
	set,
};
