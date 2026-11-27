'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import UgandaLocationSelector from '@qa-green-coder/uganda-location-selector';
import ugandaElectoralData from '@qa-green-coder/uganda-location-selector/uganda_electoral_data.json';

function buildLocationIndex(selector) {
  const locations = [];
  for (const district of selector.getDistricts()) {
    const districtPath = `${district.name}, Uganda`;
    locations.push({
      key: `district-${district.code}`,
      name: district.name,
      level: 'District',
      path: districtPath,
    });

    for (const constituency of selector.getConstituencies(district.code)) {
      const constituencyPath = `${constituency.name}, ${district.name}, Uganda`;
      locations.push({
        key: `constituency-${district.code}-${constituency.code}`,
        name: constituency.name,
        level: 'County / constituency',
        path: constituencyPath,
      });

      for (const subCounty of selector.getSubCounties(district.code, constituency.code)) {
        const subCountyPath = `${subCounty.name}, ${constituency.name}, ${district.name}, Uganda`;
        locations.push({
          key: `subcounty-${district.code}-${constituency.code}-${subCounty.code}`,
          name: subCounty.name,
          level: 'Sub-county',
          path: subCountyPath,
        });

        for (const area of selector.getElectoralAreas(district.code, constituency.code, subCounty.code)) {
          locations.push({
            key: `area-${district.code}-${constituency.code}-${subCounty.code}-${area.code}`,
            name: area.name,
            level: 'Electoral area',
            path: `${area.name}, ${subCounty.name}, ${constituency.name}, ${district.name}, Uganda`,
          });
        }
      }
    }
  }
  return locations;
}

export default function UgandaAddressInput({
  value = '',
  onChange,
  required = false,
  id = 'member-address',
}) {
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [detail, setDetail] = useState(value);
  const [selectedLocation, setSelectedLocation] = useState(null);
  const lastEmittedValue = useRef(value);

  useEffect(() => {
    try {
      const selector = new UgandaLocationSelector();
      selector.setData(ugandaElectoralData);
      setLocations(buildLocationIndex(selector));
    } catch (error) {
      setLoadError(error.message || 'Uganda location data could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const nextValue = value || '';
    if (nextValue !== lastEmittedValue.current) {
      setDetail(nextValue);
      setSelectedLocation(null);
      lastEmittedValue.current = nextValue;
    }
  }, [value]);

  const suggestions = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    if (term.length < 2) return [];
    return locations
      .filter(location =>
        location.name.toLocaleLowerCase().includes(term) ||
        location.path.toLocaleLowerCase().includes(term)
      )
      .sort((left, right) => {
        const leftStarts = left.name.toLocaleLowerCase().startsWith(term) ? 0 : 1;
        const rightStarts = right.name.toLocaleLowerCase().startsWith(term) ? 0 : 1;
        return leftStarts - rightStarts || left.name.localeCompare(right.name) || left.path.localeCompare(right.path);
      })
      .slice(0, 10);
  }, [locations, search]);

  function emitAddress(nextValue) {
    lastEmittedValue.current = nextValue;
    onChange(nextValue);
  }

  function selectLocation(location) {
    setSelectedLocation(location);
    setSearch('');
    setDetail('');
    emitAddress(location.path);
  }

  function updateDetail(nextDetail) {
    const maxDetailLength = Math.max(0, 500 - (selectedLocation?.path.length || 0) - (selectedLocation ? 2 : 0));
    const boundedDetail = nextDetail.slice(0, maxDetailLength);
    setDetail(boundedDetail);
    const nextValue = [boundedDetail.trim(), selectedLocation?.path].filter(Boolean).join(', ');
    emitAddress(nextValue);
  }

  return (
    <div className="space-y-3">
      <label htmlFor={`${id}-search`} className="block text-xs font-medium text-muted-foreground">
        Search Uganda location{required ? ' *' : ''}
      </label>
      <div className="relative">
        <input
          id={`${id}-search`}
          type="search"
          autoComplete="off"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={suggestions.length > 0}
          aria-controls={`${id}-suggestions`}
          value={search}
          onChange={event => setSearch(event.target.value)}
          placeholder="Type a district, county, sub-county, or electoral area..."
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
        {suggestions.length > 0 && (
          <ul
            id={`${id}-suggestions`}
            role="listbox"
            className="absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-border bg-card shadow-lg"
          >
            {suggestions.map(location => (
              <li key={location.key} role="option" aria-selected={false}>
                <button
                  type="button"
                  onClick={() => selectLocation(location)}
                  className="w-full px-3 py-2 text-left hover:bg-muted"
                >
                  <span className="block text-sm font-medium text-foreground">
                    {location.name} <span className="text-xs font-normal text-muted-foreground">({location.level})</span>
                  </span>
                  <span className="block text-xs text-muted-foreground">{location.path}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {search.trim().length >= 2 && suggestions.length === 0 && !loading && (
        <p className="text-xs text-muted-foreground">No matching catalog location. Enter it in the village/parish/LC1 details below.</p>
      )}
      {loading && <p className="text-xs text-muted-foreground">Loading Uganda locations…</p>}
      {loadError && <p role="alert" className="text-xs text-amber-700">{loadError} You can still enter the address manually below.</p>}

      {selectedLocation && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200">
          <span className="font-medium">Selected hierarchy:</span> {selectedLocation.path}
        </div>
      )}

      <label htmlFor={`${id}-detail`} className="block text-xs font-medium text-muted-foreground">
        Village, parish, LC1, street, plot, or other address details{required ? ' *' : ''}
      </label>
      <textarea
        id={`${id}-detail`}
        name="address"
        rows={2}
        maxLength={Math.max(1, 500 - (selectedLocation?.path.length || 0) - (selectedLocation ? 2 : 0))}
        required={required && !detail.trim() && !selectedLocation}
        value={detail}
        onChange={event => updateDetail(event.target.value)}
        placeholder="Enter the specific village, parish, LC1, street, or plot details..."
        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
      />
      <p className="text-xs text-muted-foreground">
        Selecting a catalog result fills its full district-to-area path. Your address is saved in the existing member address field.
      </p>
    </div>
  );
}
