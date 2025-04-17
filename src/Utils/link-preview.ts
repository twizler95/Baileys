import axios, { AxiosRequestConfig } from 'axios'
import { Logger } from 'pino'
import { WAMediaUploadFunction, WAUrlInfo } from '../Types'
import { prepareWAMessageMedia } from './messages'
import { extractImageThumb, getHttpStream } from './messages-media'

const THUMBNAIL_WIDTH_PX = 192

/** Fetches an image and generates a thumbnail for it */
const getCompressedJpegThumbnail = async(
	url: string,
	{ thumbnailWidth, fetchOpts }: URLGenerationOptions
) => {
	const stream = await getHttpStream(url, fetchOpts)
	const result = await extractImageThumb(stream, thumbnailWidth)
	return result
}

export type URLGenerationOptions = {
	thumbnailWidth: number
	fetchOpts: {
		/** Timeout in ms */
		timeout: number
		proxyUrl?: string
		headers?: AxiosRequestConfig<{}>['headers']
	}
	uploadImage?: WAMediaUploadFunction
	logger?: Logger
}

/**
 * Given a piece of text, checks for any URL present, generates link preview for the same and returns it
 * Return undefined if the fetch failed or no URL was found
 * @param text first matched URL in text
 * @returns the URL info required to generate link preview
 */
export const getUrlInfo = async(
	text: string,
	opts: URLGenerationOptions = {
		thumbnailWidth: THUMBNAIL_WIDTH_PX,
		fetchOpts: { timeout: 3000 }
	},
): Promise<WAUrlInfo | undefined> => {
	try {
		// retries
		const retries = 0
		const maxRetry = 5

		const { getLinkPreview, getPreviewFromContent } = await import('link-preview-js')
		
		let previewLink = text
		if(!text.startsWith('https://') && !text.startsWith('http://')) {
			previewLink = 'https://' + previewLink
		}

		const VALID_URL_REGEX = new RegExp(
			"^" +
			  // protocol identifier
			  "(?:(?:https?|ftp)://)" +
			  // user:pass authentication
			  "(?:\\S+(?::\\S*)?@)?" +
			  "(?:" +
			  // IP address exclusion
			  // private & local networks
			  "(?!(?:10|127)(?:\\.\\d{1,3}){3})" +
			  "(?!(?:169\\.254|192\\.168)(?:\\.\\d{1,3}){2})" +
			  "(?!172\\.(?:1[6-9]|2\\d|3[0-1])(?:\\.\\d{1,3}){2})" +
			  // IP address dotted notation octets
			  // excludes loopback network 0.0.0.0
			  // excludes reserved space >= 224.0.0.0
			  // excludes network & broacast addresses
			  // (first & last IP address of each class)
			  "(?:[1-9]\\d?|1\\d\\d|2[01]\\d|22[0-3])" +
			  "(?:\\.(?:1?\\d{1,2}|2[0-4]\\d|25[0-5])){2}" +
			  "(?:\\.(?:[1-9]\\d?|1\\d\\d|2[0-4]\\d|25[0-4]))" +
			  "|" +
			  // host name
			  "(?:(?:[a-z\\u00a1-\\uffff0-9]-*)*[a-z\\u00a1-\\uffff0-9]+)" +
			  // domain name
			  "(?:\\.(?:[a-z\\u00a1-\\uffff0-9]-*)*[a-z\\u00a1-\\uffff0-9]+)*" +
			  // TLD identifier
			  "(?:\\.(?:[a-z\\u00a1-\\uffff]{2,}))" +
			  // TLD may end with dot
			  "\\.?" +
			  ")" +
			  // port number
			  "(?::\\d{2,5})?" +
			  // resource path
			  "(?:[/?#]\\S*)?" +
			  "$",
			"i"
		  );

		const detectedUrl = previewLink
			.replace(/\n/g, ` `)
			.split(` `)
			.find((token) => VALID_URL_REGEX.test(token));

		if (!detectedUrl) {
			return undefined
		}

		let response = await axios.get(detectedUrl!, opts.fetchOpts);

		const rawHeaders = response.headers;

		const headers: Record<string, string> = Object.fromEntries(
			Object.entries(rawHeaders).map(([key, value]) => [key, String(value)])
		);

		const info = getPreviewFromContent({
			data: response.data,
			headers,
			url: detectedUrl
		});

			/*
		const info = await getLinkPreview(previewLink, {
			...opts.fetchOpts,
			followRedirects: 'follow',
			handleRedirects: (baseURL: string, forwardedURL: string) => {
				const urlObj = new URL(baseURL)
				const forwardedURLObj = new URL(forwardedURL)
				if(retries >= maxRetry) {
					return false
				}

				if(
					forwardedURLObj.hostname === urlObj.hostname
					|| forwardedURLObj.hostname === 'www.' + urlObj.hostname
					|| 'www.' + forwardedURLObj.hostname === urlObj.hostname
				) {
					retries + 1
					return true
				} else {
					return false
				}
			},
			headers: opts.fetchOpts as {}
		})*/

		if(info && 'title' in info && info.title) {
			const [image] = info.images

			const urlInfo: WAUrlInfo = {
				'canonical-url': info.url,
				'matched-text': text,
				title: info.title,
				description: info.description,
				originalThumbnailUrl: image
			}

			if(opts.uploadImage) {
				const { imageMessage } = await prepareWAMessageMedia(
					{ image: { url: image } },
					{
						upload: opts.uploadImage,
						mediaTypeOverride: 'thumbnail-link',
						options: opts.fetchOpts
					}
				)
				urlInfo.jpegThumbnail = imageMessage?.jpegThumbnail
					? Buffer.from(imageMessage.jpegThumbnail)
					: undefined
				urlInfo.highQualityThumbnail = imageMessage || undefined
			} else {
				try {
					urlInfo.jpegThumbnail = image
						? (await getCompressedJpegThumbnail(image, opts)).buffer
						: undefined
				} catch(error) {
					opts.logger?.debug(
						{ err: error.stack, url: previewLink },
						'error in generating thumbnail'
					)
				}
			}

			return urlInfo
		}
	} catch(error) {
		if(!error.message.includes('receive a valid')) {
			throw error
		}
	}
}