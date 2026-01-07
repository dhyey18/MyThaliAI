const mongoose = require('mongoose');

const favoriteMealItemSchema = new mongoose.Schema({
  name: { type: String, required: true },
  calories: { type: Number, required: true },
  protein: { type: Number, required: true },
  carbs: { type: Number, required: true },
  fats: { type: Number, required: true }
}, { _id: false });

const favoriteMealSchema = new mongoose.Schema({
  name: { type: String, required: true },
  items: [favoriteMealItemSchema],
  totalCalories: { type: Number, required: true },
  macros: {
    protein: { type: Number, required: true },
    carbs: { type: Number, required: true },
    fats: { type: Number, required: true }
  },
  mealType: { 
    type: String, 
    enum: ['Breakfast', 'Lunch', 'Dinner', 'Snack'],
    default: 'Lunch'
  },
  dietaryPreference: { 
    type: String, 
    enum: ['Standard', 'Jain', 'Vegan', 'Keto', 'High Protein'],
    default: 'Standard'
  },
  createdAt: { type: Date, default: Date.now }
});

favoriteMealSchema.index({ createdAt: -1 });

module.exports = mongoose.model('FavoriteMeal', favoriteMealSchema);

