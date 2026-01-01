const { GSuiteTools } = require('../src/gsuite/index');

// Mock googleapis
jest.mock('googleapis', () => {
  const mCalendar = {
    events: {
      list: jest.fn().mockResolvedValue({ data: { items: [{ summary: 'Test Event' }] } })
    }
  };
  const mGmail = {
    users: {
      messages: {
        send: jest.fn().mockResolvedValue({ data: { id: '123' } })
      }
    }
  };
  
  return {
    google: {
      auth: { GoogleAuth: jest.fn() },
      calendar: jest.fn(() => mCalendar),
      gmail: jest.fn(() => mGmail)
    }
  };
});

// Mock Auth
jest.mock('../src/gsuite/auth', () => {
  return {
    GSuiteAuth: jest.fn().mockImplementation(() => ({
      getClient: jest.fn().mockResolvedValue('fake-client')
    }))
  };
});

describe('GSuite Tools', () => {
  let tools;

  beforeEach(() => {
    tools = new GSuiteTools();
  });

  test('listEvents should return events', async () => {
    const events = await tools.listEvents({ maxResults: 5 });
    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe('Test Event');
  });

  test('sendEmail should return message id', async () => {
    const res = await tools.sendEmail({ to: 'test@example.com', subject: 'hi', body: 'msg' });
    expect(res.id).toBe('123');
  });
});
