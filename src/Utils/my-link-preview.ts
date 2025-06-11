import axios, { AxiosRequestConfig } from 'axios';
import * as cheerio from 'cheerio';
import { WAMediaUploadFunction, WAUrlInfo } from '../Types';
import { extractImageThumb, getHttpStream } from './messages-media'
import { ILogger } from './logger'
const THUMBNAIL_WIDTH_PX = 192

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
    logger?: ILogger
}


export const myGetLinkPreview = async(
    url: string,
    opts: URLGenerationOptions = {
        thumbnailWidth: THUMBNAIL_WIDTH_PX,
        fetchOpts: { timeout: 3000 }
    },
): Promise<WAUrlInfo | undefined> => {
    try {
        const response = await axios.get(url, {
            headers: { 
                'Accept-Language': 'en-US,en;q=0.9',
                'User-Agent': 'WhatsApp/2.23.10.77 A'
            },
            timeout: 8000,
        });
  
        const html = response.data;
        const $ = cheerio.load(html);
  
        let jpegThumbnail: Buffer | undefined = undefined;

        const canonicalUrl = $('meta[property="og:url"]').attr('content') || 
            $('link[rel="canonical"]').attr('href') ||
            url;

        const title =
            $('meta[property="og:title"]').attr('content') ||
            $('title').text();
  
        const description =
            $('meta[property="og:description"]').attr('content') ||
            $('meta[name="description"]').attr('content') ||
            undefined;
  
        const image =
            $('meta[property="og:image"]').attr('content') ||
            undefined;
  
        const faviconRel =
            $('link[rel="icon"]').attr('href') ||
            $('link[rel="shortcut icon"]').attr('href') ||
            $('link[rel="apple-touch-icon"]').attr('href') ||
            '/favicon.ico';
  
        const favicon = new URL(faviconRel, url).href;


        if (image) {
            try {
                jpegThumbnail = (await getCompressedJpegThumbnail(image, opts)).buffer
            } catch(error) {
                opts.logger?.debug(
                    { err: error.stack, url },
                    'error in generating thumbnail'
                )
            }
        }

  
        return { 
            'canonical-url': canonicalUrl,
            'matched-text': url,
            title,
            description,
            originalThumbnailUrl: image,
            jpegThumbnail,
        };
    } catch (error) {
        opts.logger?.debug(
            { err: error.stack, url },
            'error in getting link preview'
        )
    }
}