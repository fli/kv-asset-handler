import * as mime from 'mime'
import { Options, CacheControl, MethodNotAllowedError, NotFoundError, InternalError } from './types'

declare global {
  var __STATIC_CONTENT: any, __STATIC_CONTENT_MANIFEST: string
}
/**
 * maps the path of incoming request to the request pathKey to look up
 * in bucket and in cache
 * e.g.  for a path '/' returns '/index.html' which serves
 * the content of bucket/index.html
 * @param {Request} request incoming request
 */
const mapRequestToAsset = (request: Request) => {
  const parsedUrl = new URL(request.url)
  let pathname = parsedUrl.pathname

  if (pathname.endsWith('/')) {
    // If path looks like a directory append index.html
    // e.g. If path is /about/ -> /about/index.html
    pathname = pathname.concat('index.html')
  } else if (!mime.getType(pathname)) {
    // If path doesn't look like valid content
    //  e.g. /about.me ->  /about.me/index.html
    pathname = pathname.concat('/index.html')
  }

  parsedUrl.pathname = pathname
  return new Request(parsedUrl.toString(), request)
}

/**
 * maps the path of incoming request to /index.html if it evaluates to
 * any HTML file.
 * @param {Request} request incoming request
 */
function serveSinglePageApp(request: Request): Request {
  // First apply the default handler, which already has logic to detect
  // paths that should map to HTML files.
  request = mapRequestToAsset(request)

  const parsedUrl = new URL(request.url)

  // Detect if the default handler decided to map to
  // a HTML file in some specific directory.
  if (parsedUrl.pathname.endsWith('.html')) {
    // If expected HTML file was missing, just return the root index.html
    return new Request(`${parsedUrl.origin}/index.html`, request)
  } else {
    // The default handler decided this is not an HTML page. It's probably
    // an image, CSS, or JS file. Leave it as-is.
    return request
  }
}

const defaultCacheControl: CacheControl = {
  browser: null,
  edge: `max-age=${2 * 60 * 60 * 24}`, // 2 days
  bypassCache: false, // do not bypass Cloudflare's cache
}

/**
 * takes the path of the incoming request, gathers the appropriate content from KV, and returns
 * the response
 *
 * @param {FetchEvent} event the fetch event of the triggered request
 * @param {{mapRequestToAsset: (string: Request) => Request, cacheControl: {bypassCache:boolean, edge: string, browser:string}, ASSET_NAMESPACE: any, ASSET_MANIFEST:any}} [options] configurable options
 * @param {CacheControl} [options.cacheControl] determine how to cache on Cloudflare and the browser
 * @param {typeof(options.mapRequestToAsset)} [options.mapRequestToAsset]  maps the path of incoming request to the request pathKey to look up
 * @param {Object | string} [options.ASSET_NAMESPACE] the binding to the namespace that script references
 * @param {any} [options.ASSET_MANIFEST] the map of the key to cache and store in KV
 * */
const getAssetFromKV = async (event: FetchEvent, options?: Partial<Options>): Promise<Response> => {
  // Assign any missing options passed in to the default
  options = Object.assign(
    {
      ASSET_NAMESPACE: __STATIC_CONTENT,
      ASSET_MANIFEST: __STATIC_CONTENT_MANIFEST,
      mapRequestToAsset: mapRequestToAsset,
      cacheControl: defaultCacheControl,
      defaultMimeType: 'text/plain',
    },
    options,
  )

  const request = event.request
  const ASSET_NAMESPACE = options.ASSET_NAMESPACE
  const ASSET_MANIFEST =
    typeof options.ASSET_MANIFEST === 'string'
      ? JSON.parse(options.ASSET_MANIFEST)
      : options.ASSET_MANIFEST

  if (typeof ASSET_NAMESPACE === 'undefined') {
    throw new InternalError(`there is no KV namespace bound to the script`)
  }

  const SUPPORTED_METHODS = ['GET', 'HEAD']
  if (!SUPPORTED_METHODS.includes(request.method)) {
    throw new MethodNotAllowedError(`${request.method} is not a valid request method`)
  }

  const rawPathKey = new URL(request.url).pathname.replace(/^\/+/, '') // strip any preceding /'s
  let pathIsEncoded = false
  let requestKey
  if (ASSET_MANIFEST[rawPathKey]) {
    requestKey = request
  } else if (ASSET_MANIFEST[decodeURIComponent(rawPathKey)]) {
    pathIsEncoded = true
    requestKey = request
  } else {
    requestKey = options.mapRequestToAsset(request)
  }

  const parsedUrl = new URL(requestKey.url)
  const pathname = pathIsEncoded ? decodeURIComponent(parsedUrl.pathname) : parsedUrl.pathname // decode percentage encoded path only when necessary

  // pathKey is the file path to look up in the manifest
  let pathKey = pathname.replace(/^\/+/, '') // remove prepended /

  // @ts-ignore
  const cache = caches.default
  let mimeType = mime.getType(pathKey) || options.defaultMimeType
  if (mimeType.startsWith('text') || mimeType === 'application/javascript') {
    mimeType += '; charset=utf-8'
  }

  let shouldEdgeCache = false // false if storing in KV by raw file path i.e. no hash
  // check manifest for map from file path to hash
  if (typeof ASSET_MANIFEST !== 'undefined') {
    if (ASSET_MANIFEST[pathKey]) {
      pathKey = ASSET_MANIFEST[pathKey]
      // if path key is in asset manifest, we can assume it contains a content hash and can be cached
      shouldEdgeCache = true
    }
  }

  // TODO this excludes search params from cache, investigate ideal behavior
  let cacheKey = new Request(`${parsedUrl.origin}/${pathKey}`, request)

  // if argument passed in for cacheControl is a function then
  // evaluate that function. otherwise return the Object passed in
  // or default Object
  const evalCacheOpts = (() => {
    switch (typeof options.cacheControl) {
      case 'function':
        return options.cacheControl(request)
      case 'object':
        return options.cacheControl
      default:
        return defaultCacheControl
    }
  })()

  // formats the etag depending on the response context. if the entityId
  // is invalid, returns an empty string (instead of null) to prevent the
  // the potentially disastrous scenario where the value of the Etag resp
  // header is "null". Could be modified in future to base64 encode etc
  const formatETag = (entityId: any = pathKey, validatorType: string = 'strong') => {
    if (!entityId) {
      return ''
    }
    switch (validatorType) {
      case 'weak':
        if (!entityId.startsWith('W/')) {
          return `W/${entityId}`
        }
        console.log('weakened', entityId)
        return entityId
      case 'strong':
        if (entityId.startsWith(`W/"`)) {
          entityId = entityId.replace('W/', '')
        }
        if (!entityId.endsWith(`"`)) {
          entityId = `"${entityId}"`
        }
        return entityId
      default:
        return ''
    }
  }

  options.cacheControl = Object.assign({}, defaultCacheControl, evalCacheOpts)

  // override shouldEdgeCache if options say to bypassCache
  if (
    options.cacheControl.bypassCache ||
    options.cacheControl.edge === null ||
    request.method == 'HEAD'
  ) {
    shouldEdgeCache = false
  }

  let response = null
  if (shouldEdgeCache) {
    response = await cache.match(cacheKey)
  }

  if (response) {
    if (response.status > 300 && response.status < 400) {
      if (response.body && 'cancel' in Object.getPrototypeOf(response.body)) {
        response.body.cancel()
        console.log('Body exists and environment supports readable streams. Body cancelled')
      } else {
        console.log('Environment doesnt support readable streams')
      }
      response = new Response(null, response)
    } else {
      response = new Response(response.body, response)
      response.headers.set('cf-cache-status', 'HIT')
    }
  } else {
    const body = await ASSET_NAMESPACE.get(pathKey, 'arrayBuffer')
    if (body === null) {
      throw new NotFoundError(`could not find ${pathKey} in your content namespace`)
    }
    response = new Response(body)

    if (shouldEdgeCache) {
      response.headers.set('Accept-Ranges', 'bytes')
      response.headers.set('Content-Length', body.length)
      // set etag before cache insertion
      if (!response.headers.has('etag')) {
        response.headers.set('etag', formatETag(pathKey, 'strong'))
      }
      // determine Cloudflare cache behavior
      response.headers.set('Cache-Control', options.cacheControl.edge)
      event.waitUntil(cache.put(cacheKey, response.clone()))
      response.headers.set('CF-Cache-Status', 'MISS')
    }
  }
  response.headers.set('Content-Type', mimeType)

  if (response.status === 304) {
    let etag = formatETag(response.headers.get('etag'), 'strong')
    let ifNoneMatch = cacheKey.headers.get('if-none-match')
    let proxyCacheStatus = response.headers.get('CF-Cache-Status')
    if (etag) {
      if (ifNoneMatch && ifNoneMatch === etag && proxyCacheStatus === 'MISS') {
        response.headers.set('CF-Cache-Status', 'EXPIRED')
      } else {
        response.headers.set('CF-Cache-Status', 'REVALIDATED')
      }
      response.headers.set('etag', formatETag(etag, 'weak'))
    }
  }
  if (options.cacheControl.browser) {
    response.headers.set('Cache-Control', options.cacheControl.browser)
  } else {
    response.headers.delete('Cache-Control')
  }
  return response
}

export { getAssetFromKV, mapRequestToAsset, serveSinglePageApp }
export { Options, CacheControl, MethodNotAllowedError, NotFoundError, InternalError }
