// Import Mapbox as an ESM module
import mapboxgl from 'https://cdn.jsdelivr.net/npm/mapbox-gl@2.15.0/+esm';
// Import D3 as an ES module
import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm';

// Check that Mapbox GL JS is loaded
console.log('Mapbox GL JS Loaded:', mapboxgl);

// Set your Mapbox access token here
mapboxgl.accessToken = 'pk.eyJ1IjoiY2hzMDE5IiwiYSI6ImNtaHpwN25rNzBldmsya3E1NmFidG5icTkifQ.GzhjSurtv5YaKV27YtvW9Q';

// Initialize the map
const map = new mapboxgl.Map({
  container: 'map', // ID of the div where the map will render
  style: 'mapbox://styles/mapbox/streets-v12', // Map style
  center: [-71.09415, 42.36027], // [longitude, latitude] - Boston area
  zoom: 12, // Initial zoom level
  minZoom: 5, // Minimum allowed zoom
  maxZoom: 18, // Maximum allowed zoom
});

// Bluebikes stations JSON URL
const INPUT_BLUEBIKES_CSV_URL = 'https://dsc106.com/labs/lab07/data/bluebikes-stations.json';

// Shared bike lane styling
const bikeLaneStyle = {
  'line-color': '#32D400', // A bright green using hex code
  'line-width': 5, // Thicker lines
  'line-opacity': 0.6, // Slightly less transparent
};

// Performance optimization: minute buckets for trips
let departuresByMinute = Array.from({ length: 1440 }, () => []);
let arrivalsByMinute = Array.from({ length: 1440 }, () => []);

// Helper function to convert station coordinates to pixel coordinates
function getCoords(station) {
  // Handle both lowercase and capitalized property names
  const lon = station.lon || station.Long || station.long;
  const lat = station.lat || station.Lat;
  const point = new mapboxgl.LngLat(+lon, +lat); // Convert lon/lat to Mapbox LngLat
  const { x, y } = map.project(point); // Project to pixel coordinates
  return { cx: x, cy: y }; // Return as object for use in SVG attributes
}

// Helper function to convert Date to minutes since midnight
function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

// Helper function to format time from minutes since midnight
function formatTime(minutes) {
  const date = new Date(0, 0, 0, 0, minutes); // Set hours & minutes
  return date.toLocaleString('en-US', { timeStyle: 'short' }); // Format as HH:MM AM/PM
}

// Efficient filtering function using minute buckets
function filterByMinute(tripsByMinute, minute) {
  if (minute === -1) {
    return tripsByMinute.flat(); // No filtering, return all trips
  }

  // Normalize both min and max minutes to the valid range [0, 1439]
  let minMinute = (minute - 60 + 1440) % 1440;
  let maxMinute = (minute + 60) % 1440;

  // Handle time filtering across midnight
  if (minMinute > maxMinute) {
    let beforeMidnight = tripsByMinute.slice(minMinute);
    let afterMidnight = tripsByMinute.slice(0, maxMinute);
    return beforeMidnight.concat(afterMidnight).flat();
  } else {
    return tripsByMinute.slice(minMinute, maxMinute).flat();
  }
}

// Function to compute station traffic from filtered trips
function computeStationTraffic(stations, timeFilter = -1) {
  // Retrieve filtered trips efficiently
  const departures = d3.rollup(
    filterByMinute(departuresByMinute, timeFilter), // Efficient retrieval
    (v) => v.length,
    (d) => d.start_station_id
  );

  const arrivals = d3.rollup(
    filterByMinute(arrivalsByMinute, timeFilter), // Efficient retrieval
    (v) => v.length,
    (d) => d.end_station_id
  );

  // Update each station with calculated values
  return stations.map((station) => {
    let id = station.short_name;
    station.arrivals = arrivals.get(id) ?? 0;
    station.departures = departures.get(id) ?? 0;
    station.totalTraffic = station.arrivals + station.departures;
    return station;
  });
}

// Wait for map to load before adding data
map.on('load', async () => {
  // Add Boston bike lanes data source
  map.addSource('boston_route', {
    type: 'geojson',
    data: 'https://bostonopendata-boston.opendata.arcgis.com/datasets/boston::existing-bike-network-2022.geojson',
  });

  // Add Boston bike lanes layer
  map.addLayer({
    id: 'bike-lanes',
    type: 'line',
    source: 'boston_route',
    paint: bikeLaneStyle,
  });

  // Add Cambridge bike lanes data source
  map.addSource('cambridge_route', {
    type: 'geojson',
    data: 'https://data.cambridgema.gov/api/geospatial/bike-facilities?method=export&format=GeoJSON',
  });

  // Add Cambridge bike lanes layer
  map.addLayer({
    id: 'cambridge-bike-lanes',
    type: 'line',
    source: 'cambridge_route',
    paint: bikeLaneStyle,
  });

  // Select the SVG element inside the map container
  const svg = d3.select('#map').select('svg');

  // Fetch and parse Bluebikes station data
  let jsonData;
  try {
    const jsonurl = INPUT_BLUEBIKES_CSV_URL;

    // Await JSON fetch
    jsonData = await d3.json(jsonurl);

    console.log('Loaded JSON Data:', jsonData); // Log to verify structure
  } catch (error) {
    console.error('Error loading JSON:', error); // Handle errors
    return; // Exit if data loading fails
  }

  // Access the stations array from the JSON structure
  let originalStations = jsonData.data.stations;
  console.log('Stations Array:', originalStations);

  // Load and parse traffic CSV data
  let trips = await d3.csv(
    'https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv',
    (trip) => {
      trip.started_at = new Date(trip.started_at);
      trip.ended_at = new Date(trip.ended_at);
      
      // Add trips to minute buckets for performance optimization
      let startedMinutes = minutesSinceMidnight(trip.started_at);
      departuresByMinute[startedMinutes].push(trip);
      
      let endedMinutes = minutesSinceMidnight(trip.ended_at);
      arrivalsByMinute[endedMinutes].push(trip);
      
      return trip;
    }
  );

  console.log('Loaded trips:', trips.length);

  // Compute initial station traffic (no filter)
  let stations = computeStationTraffic(originalStations);
  console.log('Stations with traffic:', stations);

  // Create radius scale using square root scale for area-based visualization
  const radiusScale = d3
    .scaleSqrt()
    .domain([0, d3.max(stations, (d) => d.totalTraffic)])
    .range([0, 25]);

  // Create quantize scale for traffic flow (departures ratio)
  const stationFlow = d3.scaleQuantize().domain([0, 1]).range([0, 0.5, 1]);

  // Append circles to the SVG for each station
  const circles = svg
    .selectAll('circle')
    .data(stations, (d) => d.short_name) // Use station short_name as the key
    .enter()
    .append('circle')
    .attr('r', (d) => radiusScale(d.totalTraffic)) // Size based on traffic
    .attr('fill-opacity', 0.6) // 60% opacity
    .attr('stroke', 'white') // Circle border color
    .attr('stroke-width', 1) // Circle border thickness
    .style('--departure-ratio', (d) => {
      // Handle division by zero case
      const ratio = d.totalTraffic > 0 ? d.departures / d.totalTraffic : 0.5;
      return stationFlow(ratio);
    })
    .each(function (d) {
      // Add <title> for browser tooltips
      d3.select(this)
        .append('title')
        .text(
          `${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`
        );
    });

  // Function to update circle positions when the map moves/zooms
  function updatePositions() {
    circles
      .attr('cx', (d) => getCoords(d).cx) // Set the x-position using projected coordinates
      .attr('cy', (d) => getCoords(d).cy); // Set the y-position using projected coordinates
  }

  // Initial position update when map loads
  updatePositions();

  // Reposition markers on map interactions
  map.on('move', updatePositions); // Update during map movement
  map.on('zoom', updatePositions); // Update during zooming
  map.on('resize', updatePositions); // Update on window resize
  map.on('moveend', updatePositions); // Final adjustment after movement ends

  // Get slider and display elements
  const timeSlider = document.querySelector('#time-slider');
  const selectedTime = document.querySelector('#selected-time');
  const anyTimeLabel = document.querySelector('#any-time');

  // Function to update scatterplot based on time filter
  function updateScatterPlot(timeFilter) {
    // Recompute station traffic based on the filtered trips
    // Use original stations array to avoid modifying already-modified data
    const filteredStations = computeStationTraffic(originalStations, timeFilter);

    // Adjust radius scale range based on whether filtering is applied
    // Domain stays the same for consistency, only range changes for visibility
    timeFilter === -1 ? radiusScale.range([0, 25]) : radiusScale.range([3, 50]);

    // Update the scatterplot by adjusting the radius of circles
    circles
      .data(filteredStations, (d) => d.short_name) // Ensure D3 tracks elements correctly
      .join('circle')
      .attr('r', (d) => radiusScale(d.totalTraffic)) // Update circle sizes
      .attr('fill-opacity', 0.6)
      .attr('stroke', 'white')
      .attr('stroke-width', 1)
      .style('--departure-ratio', (d) => {
        // Handle division by zero case
        const ratio = d.totalTraffic > 0 ? d.departures / d.totalTraffic : 0.5;
        return stationFlow(ratio);
      })
      .each(function (d) {
        // Update tooltips
        d3.select(this).select('title').remove(); // Remove old title
        d3.select(this)
          .append('title')
          .text(
            `${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`
          );
      });

    // Update positions after data change
    updatePositions();
  }

  // Function to update time display and trigger scatterplot update
  function updateTimeDisplay() {
    let timeFilter = Number(timeSlider.value); // Get slider value

    if (timeFilter === -1) {
      selectedTime.textContent = ''; // Clear time display
      anyTimeLabel.style.display = 'block'; // Show "(any time)"
    } else {
      selectedTime.textContent = formatTime(timeFilter); // Display formatted time
      anyTimeLabel.style.display = 'none'; // Hide "(any time)"
    }

    // Call updateScatterPlot to reflect the changes on the map
    updateScatterPlot(timeFilter);
  }

  // Bind slider input event to update function
  timeSlider.addEventListener('input', updateTimeDisplay);
  updateTimeDisplay(); // Initial call
});