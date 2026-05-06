const express = require('express');
const router = express.Router();
const Appointment = require('../models/Appointment');
const Settings = require('../models/Settings');

// Helper: get or create settings
async function getSettings() {
  let settings = await Settings.findOne();
  if (!settings) {
    settings = await Settings.create({});
  }
  return settings;
}

// Helper: recalculate queue positions for a given date
async function recalculateQueue(date) {
  const settings = await getSettings();
  const appointments = await Appointment.find({
    date: date,
    status: { $in: ['Scheduled', 'In Progress'] }
  }).sort({ createdAt: 1 });

  for (let i = 0; i < appointments.length; i++) {
    appointments[i].queuePosition = i + 1;
    await appointments[i].save();
  }
  return appointments;
}

// GET admin dashboard stats
router.get('/dashboard', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    
    const totalToday = await Appointment.countDocuments({ date: today, status: { $ne: 'Cancelled' } });
    const completed = await Appointment.countDocuments({ date: today, status: 'Completed' });
    const inProgress = await Appointment.countDocuments({ date: today, status: 'In Progress' });
    const scheduled = await Appointment.countDocuments({ date: today, status: 'Scheduled' });
    const cancelled = await Appointment.countDocuments({ date: today, status: 'Cancelled' });
    const totalAll = await Appointment.countDocuments();
    
    const currentAppointment = await Appointment.findOne({ date: today, status: 'In Progress' });
    const nextAppointment = await Appointment.findOne({ 
      date: today, 
      status: 'Scheduled' 
    }).sort({ queuePosition: 1 });

    const settings = await getSettings();

    res.json({
      today: {
        total: totalToday,
        completed,
        inProgress,
        scheduled,
        cancelled
      },
      totalAll,
      currentAppointment,
      nextAppointment,
      settings
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST mark current as completed and move queue forward
router.post('/next', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const date = req.body.date || today;

    // Mark current in-progress as completed
    const current = await Appointment.findOne({ date: date, status: 'In Progress' });
    if (current) {
      current.status = 'Completed';
      await current.save();
    }

    // Find next scheduled appointment
    const next = await Appointment.findOne({
      date: date,
      status: 'Scheduled'
    }).sort({ queuePosition: 1 });

    if (next) {
      next.status = 'In Progress';
      await next.save();

      // Recalculate estimated wait times for remaining
      const remaining = await Appointment.find({
        date: date,
        status: 'Scheduled'
      }).sort({ queuePosition: 1 });

      const settings = await getSettings();
      for (let i = 0; i < remaining.length; i++) {
        remaining[i].estimatedWaitTime = (i + 1) * settings.avgServiceTime;
        await remaining[i].save();
      }

      res.json({ 
        message: 'Queue moved forward', 
        completed: current, 
        nowServing: next,
        remaining: remaining.length
      });
    } else {
      res.json({ 
        message: 'No more appointments in queue', 
        completed: current,
        nowServing: null,
        remaining: 0
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST start serving (set first scheduled to in-progress)
router.post('/start', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const date = req.body.date || today;

    const existing = await Appointment.findOne({ date: date, status: 'In Progress' });
    if (existing) {
      return res.json({ message: 'Already serving', nowServing: existing });
    }

    const next = await Appointment.findOne({
      date: date,
      status: 'Scheduled'
    }).sort({ queuePosition: 1 });

    if (next) {
      next.status = 'In Progress';
      await next.save();
      res.json({ message: 'Started serving', nowServing: next });
    } else {
      res.json({ message: 'No appointments to serve' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT cancel appointment
router.put('/cancel/:id', async (req, res) => {
  try {
    const appointment = await Appointment.findOne({ appointmentId: req.params.id });
    if (!appointment) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    appointment.status = 'Cancelled';
    await appointment.save();

    // Recalculate queue
    await recalculateQueue(appointment.date);

    res.json({ message: 'Appointment cancelled', appointment });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT reschedule appointment
router.put('/reschedule/:id', async (req, res) => {
  try {
    const { date, timeSlot } = req.body;
    if (!date || !timeSlot) {
      return res.status(400).json({ error: 'Date and timeSlot are required' });
    }

    const appointment = await Appointment.findOne({ appointmentId: req.params.id });
    if (!appointment) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    // Check slot availability
    const settings = await getSettings();
    const existingCount = await Appointment.countDocuments({
      date: date,
      timeSlot: timeSlot,
      status: { $ne: 'Cancelled' },
      appointmentId: { $ne: req.params.id }
    });

    if (existingCount >= settings.maxAppointmentsPerSlot) {
      return res.status(409).json({ error: 'Selected slot is fully booked' });
    }

    const oldDate = appointment.date;
    appointment.date = date;
    appointment.timeSlot = timeSlot;
    appointment.status = 'Scheduled';
    await appointment.save();

    // Recalculate queues for both dates
    await recalculateQueue(oldDate);
    await recalculateQueue(date);

    res.json({ message: 'Appointment rescheduled', appointment });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT update settings
router.put('/settings', async (req, res) => {
  try {
    const settings = await getSettings();
    const { maxAppointmentsPerSlot, avgServiceTime } = req.body;

    if (maxAppointmentsPerSlot) settings.maxAppointmentsPerSlot = maxAppointmentsPerSlot;
    if (avgServiceTime) settings.avgServiceTime = avgServiceTime;

    await settings.save();
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET settings
router.get('/settings', async (req, res) => {
  try {
    const settings = await getSettings();
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
