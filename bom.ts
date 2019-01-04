import {
  findNearest
} from 'geolib';
import * as cacheManager from 'cache-manager';
import * as FtpClient from 'ftp';
import {
  parseString
} from 'xml2js';

import * as ausPostcodes from './au_postcodes';
import { Icons } from './bom-icons';

export interface IWeatherFeed {
  forecast: string;
  observations: string;
}

export const BOM_FTP_HOST = 'ftp.bom.gov.au';
export const AuPostcodes = ausPostcodes;
export const BomIcons = Icons;
export const WeatherFeeds: {
  [state: string]: IWeatherFeed;
} = {
  ACT: {
    forecast: '/anon/gen/fwo/IDN11060.xml',
    observations: '/anon/gen/fwo/IDN60920.xml'
  },
  NSW: {
    forecast: '/anon/gen/fwo/IDN11060.xml',
    observations: '/anon/gen/fwo/IDN60920.xml'
  },
  NT: {
    forecast: '/anon/gen/fwo/IDD10207.xml',
    observations: '/anon/gen/fwo/IDD60920.xml'
  },
  QLD: {
    forecast: '/anon/gen/fwo/IDQ11295.xml',
    observations: '/anon/gen/fwo/IDQ60920.xml'
  },
  SA: {
    forecast: '/anon/gen/fwo/IDS10044.xml',
    observations: '/anon/gen/fwo/IDS60920.xml'
  },
  TAS: {
    forecast: '/anon/gen/fwo/IDT16710.xml',
    observations: '/anon/gen/fwo/IDT60920.xml'
  },
  VIC: {
    forecast: '/anon/gen/fwo/IDV10753.xml',
    observations: '/anon/gen/fwo/IDV60920.xml'
  },
  WA: {
    forecast: '/anon/gen/fwo/IDW14199.xml',
    observations: '/anon/gen/fwo/IDW60920.xml'
  }
};

export class BomConfig {
  bomHostname ? : string;
  cacheStore ? : string | any;
  ttl ? : number;
  cacheOptions ? : any;
}

export class Bom {
  private config: BomConfig;
  private dataCache;
  private statePostcodeCache = {};

  constructor(config ? : BomConfig) {
    this.config = {
      bomHostname: BOM_FTP_HOST,
      cacheStore: 'memory',
      ttl: 300,
      ...config
    };

    this.dataCache = cacheManager.caching({
      store: this.config.cacheStore,
      ttl: this.config.ttl,
      ...this.config.cacheOptions
    });
  }

  getIconMeaning(icon: number | string) {
    return BomIcons[icon.toString()]
  }

  async downloadParsedStateData(state: string) {
    return new Promise < any > ((resolve, reject) => {
      const c = new FtpClient();

      const downloadAndParseFtpUrl = url =>
        new Promise((resolve, reject) => {
          c.get(url, (err, stream) => {
            if (err) return reject(err);

            const chunks = [];
            stream.on('data', chunk => {
              chunks.push(chunk.toString());
            });

            stream.once('close', () => {
              const data = chunks.join('');
              parseString(data, (pErr, parsedData) => {
                if (pErr) {
                  return reject(pErr);
                }
                resolve(parsedData);
              });
            });
          });
        });

      c.on('ready', async () => {
        try {
          const value = await Promise.all([
            downloadAndParseFtpUrl(WeatherFeeds[state].forecast),
            downloadAndParseFtpUrl(WeatherFeeds[state].observations)
          ]);

          c.end();

          resolve({
            forecast: value[0],
            observations: value[1]
          });
        } catch (e) {
          reject(e);
        }
      });

      c.connect({
        host: this.config.bomHostname
      });
    });
  }

  async getParsedStateData(state: string) {
    try {
      const data = await this.dataCache.get(state);
      if (data) return data;
    } catch {}

    const parsedData = await this.downloadParsedStateData(state);
    await this.dataCache.set(state, parsedData);
    return parsedData;
  }

  protected _isSameState(s1: string, s2: string): boolean {
    const fs1 = s1.trim().toUpperCase()
    const fs2 = s2.trim().toUpperCase()

    return (fs1 == fs2) || (['NSWACT','ACTNSW'].indexOf(fs1+fs2) >= 0)
  }

  protected _formatStationData(s) {
    const elements = {}

    if (s.period[0].level[0].element &&
      s.period[0].level[0].element instanceof Array) {
      s.period[0].level[0].element.map((e) => {
        const units = e.$.units ? e.$.units : undefined
        const parsedValue = parseFloat(e._)
        const value = isNaN(parsedValue) ? e._ : parsedValue
        elements[e.$.type] = units ? {
          value,
          units
        } : value
      })
    }

    const id = s.$['forecast-district-id']

    const obj = {
      latitude: parseFloat(s.$.lat),
      longitude: parseFloat(s.$.lon),
      forecastDistrictId: id,
      tz: s.$.tz,
      name: s.$['stn-name'],
      height: parseFloat(s.$['stn-height']),
      description: s.$.description,
      type: s.$.type,
      period: {
        ...s.period[0].$,
        level: {
          ...s.period[0].level[0].$,
          elements
        }
      },
      state: id ? id.split('_')[0] : null
    }

    return obj
  }

  protected _formatForecast(xmlStructure) {
    const obj = {
      ...xmlStructure.$
    }

    xmlStructure.element.map((e) => {
      const units = e.$.units ? e.$.units : undefined
      const parsedValue = parseFloat(e._)
      const value = isNaN(parsedValue) ? e._ : parsedValue
      obj[e.$.type] = units ? {
        value,
        units
      } : value
      if (e.$.type === 'forecast_icon_code') {
        obj['icon'] = this.getIconMeaning(value)
      }
    })

    xmlStructure.text.map((e) => {
      obj[e.$.type] = e._
    })

    return obj
  }

  async getStationById(id: string) {
    const state = id ? id.toUpperCase().split('_')[0] : null

    if (!state) {
      throw new Error(`Invalid station id ${id}`)
    }

    const {
      observations
    } = await this.getParsedStateData(state);

    const station = observations.product.observations[0].station.find(s => s.$['forecast-district-id'] === id.toUpperCase())

    if (station) {
      return this._formatStationData(station)
    }

    return null
  }

  async getNearestStation(latitude: number, longitude: number) {
    const nearest = findNearest({
      latitude,
      longitude
    }, ausPostcodes);

    const closest = ausPostcodes[(nearest as any).key];
    const state = closest.state_code.toUpperCase();

    const {
      observations
    } = await this.getParsedStateData(state);
    const stations = observations.product.observations[0].station.map(s => this._formatStationData(s));

    const nearestStationResult = findNearest({
      latitude,
      longitude
    }, stations);
    const nearestStation = stations[(nearestStationResult as any).key];
    return nearestStation
  }

  async getNearestStationByPostcode(postcode: number) {
    const pcData = ausPostcodes.find(p => p.postcode === postcode)

    if (!pcData) {
      return null
    }

    return this.getNearestStation(pcData.latitude, pcData.longitude)
  }

  protected _getStatePostcodes(state: string) {
    if (!this.statePostcodeCache[state]) {
      this.statePostcodeCache[state] =
        ausPostcodes.filter(p => this._isSameState(p.state_code, state))
    }

    return this.statePostcodeCache[state]
  }

  async getForecastData(latitude: number, longitude: number) {
    const nearestStation = await this.getNearestStation(latitude, longitude)
    const statePostcodes = this._getStatePostcodes(nearestStation.state)

    const {
      forecast
    } = await this.getParsedStateData(nearestStation.state);

    const matchedAreas = forecast.product.forecast[0].area.filter(
      a => a.$['parent-aac'] === nearestStation.forecastDistrictId
    );

    const mappedAreasLocation = matchedAreas
      .map(area => {
        const postcodeLocation = statePostcodes.find(
          p => p.place_name.toUpperCase() === area.$.description.toUpperCase()
        );

        if (!postcodeLocation) return null;

        return {
          aac: area.$.aac,
          parent_aac: area.$['parent-aac'],
          type: area.$.type,
          name: postcodeLocation.place_name,
          longitude: postcodeLocation.longitude,
          latitude: postcodeLocation.latitude,
          forecast: area['forecast-period'].map(f => this._formatForecast(f))
        };
      })
      .filter(a => a);

    const nearestAreaResult = findNearest({
        latitude,
        longitude
      },
      mappedAreasLocation
    );

    const nearestArea = mappedAreasLocation[(nearestAreaResult as any).key];

    return nearestArea;
  }

  async getForecastDataByPostcode(postcode: number) {
    const pcData = ausPostcodes.find(p => p.postcode === postcode)
    if (!pcData) {
      return null
    }

    return this.getForecastData(pcData.latitude, pcData.longitude)
  }
}

export default Bom;
