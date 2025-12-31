const mongoose = require('mongoose');

const mealItemSchema = new mongoose.Schema({
  name: { type: String, required: true },
  calories: { type: Number, required: true },
  protein: { type: Number, required: true },
  carbs: { type: Number, required: true },
  fats: { type: Number, required: true }
}, { _id: false });

const mealSchema = new mongoose.Schema({
  imageUrl: { type: String },
  items: [mealItemSchema],
  totalCalories: { type: Number, required: true },
  macros: {
    protein: { type: Number, required: true },
    carbs: { type: Number, required: true },
    fats: { type: Number, required: true }
  },
  timestamp: { type: Date, default: Date.now },
  mealType: { 
    type: String, 
    enum: ['Breakfast', 'Lunch', 'Dinner', 'Snack'],
    required: true 
  },
  dietaryPreference: { 
    type: String, 
    enum: ['Standard', 'Jain', 'Vegan', 'Keto', 'High Protein'],
    default: 'Standard'
  },
  advice: { type: String },
  createdAt: { type: Date, default: Date.now }
});

mealSchema.index({ timestamp: -1 });
mealSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Meal', mealSchema);

