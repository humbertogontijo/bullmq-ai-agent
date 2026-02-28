import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool } from '../../src/index.js';

// ---------------------------------------------------------------------------
// Flight tools
// ---------------------------------------------------------------------------

const SearchFlightsSchema = Type.Object({
  origin: Type.String({ description: 'Origin airport code (e.g. SFO)' }),
  destination: Type.String({ description: 'Destination airport code (e.g. JFK)' }),
  date: Type.String({ description: 'Travel date in YYYY-MM-DD format' }),
});

export const searchFlights: AgentTool<typeof SearchFlightsSchema> = {
  name: 'SearchFlights',
  description: 'Search for available flights between two airports on a given date',
  schema: SearchFlightsSchema,
  handler: async (args: Static<typeof SearchFlightsSchema>) => ({
    flights: [
      { id: 'UA-142', price: 299, departure: '08:00', arrival: '16:30' },
      { id: 'DL-587', price: 349, departure: '12:15', arrival: '20:45' },
      { id: 'AA-901', price: 279, departure: '18:00', arrival: '02:30' },
    ],
  }),
};

const BookFlightSchema = Type.Object({
  flightId: Type.String({ description: 'Flight ID to book (e.g. UA-142)' }),
  passengers: Type.Number({ description: 'Number of passengers' }),
});

export const bookFlight: AgentTool<typeof BookFlightSchema> = {
  name: 'BookFlight',
  description: 'Book a specific flight for the given number of passengers',
  schema: BookFlightSchema,
  handler: async (args: Static<typeof BookFlightSchema>) => ({
    confirmation: `BK-${Date.now()}`,
    flight: args.flightId,
    passengers: args.passengers,
    status: 'confirmed',
  }),
};

// ---------------------------------------------------------------------------
// HR / PTO tools
// ---------------------------------------------------------------------------

const CheckPTOSchema = Type.Object({
  employeeId: Type.String({ description: 'Employee ID' }),
});

export const checkPTO: AgentTool<typeof CheckPTOSchema> = {
  name: 'CheckPTO',
  description: 'Check how many PTO days an employee has available',
  schema: CheckPTOSchema,
  handler: async (args: Static<typeof CheckPTOSchema>) => ({
    employeeId: args.employeeId,
    available: 15,
    used: 5,
    total: 20,
  }),
};

const BookPTOSchema = Type.Object({
  employeeId: Type.String({ description: 'Employee ID' }),
  startDate: Type.String({ description: 'Start date (YYYY-MM-DD)' }),
  endDate: Type.String({ description: 'End date (YYYY-MM-DD)' }),
  reason: Type.String({ description: 'Reason for time off' }),
});

export const bookPTO: AgentTool<typeof BookPTOSchema> = {
  name: 'BookPTO',
  description: 'Schedule PTO for an employee between two dates',
  schema: BookPTOSchema,
  handler: async (args: Static<typeof BookPTOSchema>) => ({
    confirmation: `PTO-${Date.now()}`,
    employeeId: args.employeeId,
    dates: `${args.startDate} to ${args.endDate}`,
    status: 'approved',
  }),
};
